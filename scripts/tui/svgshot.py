"""Render pyte terminal snapshots as crisp, font-independent SVG (static or CSS-animated).

Box-drawing, block and braille glyphs are drawn as vectors, so the picture looks the same on every
machine; ordinary text gets one explicit x per character so a different fallback font can't shift it.

    from ptyshot import Session
    from svgshot import snapshot, render_svg

    s = Session([...], cols=100, rows=34)
    ...
    frames = [snapshot(s.screen)]
    open("out.svg", "w").write(render_svg(frames, title="revcode"))
"""
from html import escape

from ptyshot import DEFAULT_BG, DEFAULT_FG, _color

CW, CH = 9, 19  # cell size in px (integers keep strokes and block edges seamless)
FONT_SIZE = 14.5
BASELINE = 14
FONT = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace"
UI_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

# (left, right, up, down) line weight per box-drawing character: 1 light, 2 heavy, 3 double
BOX = {}
for chars, w in (("─│┌┐└┘├┤┬┴┼", 1), ("━┃┏┓┗┛┣┫┳┻╋", 2), ("═║╔╗╚╝╠╣╦╩╬", 3)):
    horiz, vert, tl, tr, bl, br, lt, rt, tt, bt, cross = chars
    BOX[horiz] = (w, w, 0, 0)
    BOX[vert] = (0, 0, w, w)
    BOX[tl] = (0, w, 0, w)
    BOX[tr] = (w, 0, 0, w)
    BOX[bl] = (0, w, w, 0)
    BOX[br] = (w, 0, w, 0)
    BOX[lt] = (0, w, w, w)
    BOX[rt] = (w, 0, w, w)
    BOX[tt] = (w, w, 0, w)
    BOX[bt] = (w, w, w, 0)
    BOX[cross] = (w, w, w, w)
BOX["⎿"] = (0, 1, 1, 0)  # the tool-output elbow
for ch in "┄┈╌":
    BOX[ch] = (1, 1, 0, 0)
for ch in "┆┊╎":
    BOX[ch] = (0, 0, 1, 1)
ROUND = {"╭": (0, 1, 0, 1), "╮": (1, 0, 0, 1), "╰": (0, 1, 1, 0), "╯": (1, 0, 1, 0)}

SHADES = {"░": 0.25, "▒": 0.5, "▓": 0.75}


class Frame:
    def __init__(self, rows, cursor):
        self.rows = rows
        self.cursor = cursor

    def last_row(self):
        for y in range(len(self.rows) - 1, -1, -1):
            if any(c.data.strip() or c.bg != "default" for c in self.rows[y]):
                return y
        return 0


def snapshot(screen, cursor=True):
    rows = [[screen.buffer[y][x] for x in range(screen.columns)] for y in range(screen.lines)]
    cur = None if (screen.cursor.hidden or not cursor) else (screen.cursor.x, screen.cursor.y)
    return Frame(rows, cur)


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(rgb)


def _vector(ch, x, y, fg):
    """SVG for glyphs we draw ourselves, or None when `ch` is ordinary text."""
    out = []
    cx, cy = x + CW // 2 + 0.5, y + CH // 2 + 0.5
    if ch == "█":
        return f'<rect x="{x}" y="{y}" width="{CW}" height="{CH}" fill="{fg}"/>'
    if ch in SHADES:
        return f'<rect x="{x}" y="{y}" width="{CW}" height="{CH}" fill="{fg}" fill-opacity="{SHADES[ch]}"/>'
    half = {"▀": (0, 0, CW, CH // 2), "▄": (0, CH // 2, CW, CH - CH // 2), "▌": (0, 0, CW // 2, CH), "▐": (CW // 2, 0, CW - CW // 2, CH)}
    if ch in half:
        dx, dy, w, h = half[ch]
        return f'<rect x="{x + dx}" y="{y + dy}" width="{w}" height="{h}" fill="{fg}"/>'
    if "▁" <= ch <= "▇":  # lower eighths
        h = round(CH * (ord(ch) - 0x2580) / 8)
        return f'<rect x="{x}" y="{y + CH - h}" width="{CW}" height="{h}" fill="{fg}"/>'
    if "▉" <= ch <= "▏":  # left eighths: ▉ is 7/8 ... ▏ is 1/8
        w = round(CW * (8 - (ord(ch) - 0x2588)) / 8)
        return f'<rect x="{x}" y="{y}" width="{w}" height="{CH}" fill="{fg}"/>'
    if "⠀" <= ch <= "⣿":  # braille: 2x4 dots
        bits = ord(ch) - 0x2800
        order = [(0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08), (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80)]
        for col, row, bit in order:
            if bits & bit:
                out.append(f'<circle cx="{x + 2.5 + col * 4}" cy="{y + 3.5 + row * 4}" r="1.3" fill="{fg}"/>')
        return "".join(out)
    if ch in BOX:
        l, r, u, d = BOX[ch]
        return _box(cx, cy, x, y, l, r, u, d, fg)
    if ch in ROUND:
        l, r, u, d = ROUND[ch]
        rad = 5
        sx = 1 if r else -1
        sy = 1 if d else -1
        edge_x = x + CW if r else x
        edge_y = y + CH if d else y
        path = f"M{cx},{edge_y} L{cx},{cy + sy * rad} Q{cx},{cy} {cx + sx * rad},{cy} L{edge_x},{cy}"
        return f'<path d="{path}" fill="none" stroke="{fg}" stroke-width="1"/>'
    return None


def _box(cx, cy, x, y, l, r, u, d, fg):
    segs = []
    if 3 in (l, r, u, d):
        g = 1.5  # half the distance between the two strands of a double line
        l, r, u, d = (w == 3 for w in (l, r, u, d))
        vertical, horizontal = u or d, l or r
        for s in (-1, 1):  # strand above/below (horizontals) and left/right (verticals)
            y_s, x_s = cy + s * g, cx + s * g
            if horizontal:
                has = (u if s < 0 else d)
                if r:
                    segs.append(f"M{cx + g if has else (cx - g if vertical else cx)},{y_s}L{x + CW},{y_s}")
                if l:
                    segs.append(f"M{x},{y_s}L{cx - g if has else (cx + g if vertical else cx)},{y_s}")
            if vertical:
                has = (l if s < 0 else r)
                if d:
                    segs.append(f"M{x_s},{cy + g if has else (cy - g if horizontal else cy)}L{x_s},{y + CH}")
                if u:
                    segs.append(f"M{x_s},{y}L{x_s},{cy - g if has else (cy + g if horizontal else cy)}")
        return f'<path d="{"".join(segs)}" fill="none" stroke="{fg}" stroke-width="1"/>'
    heavy = 2 in (l, r, u, d)
    if heavy:
        cx, cy = cx + 0.5, cy + 0.5
    if l:
        segs.append(f"M{x},{cy}L{cx},{cy}")
    if r:
        segs.append(f"M{cx},{cy}L{x + CW},{cy}")
    if u:
        segs.append(f"M{cx},{y}L{cx},{cy}")
    if d:
        segs.append(f"M{cx},{cy}L{cx},{y + CH}")
    return f'<path d="{"".join(segs)}" fill="none" stroke="{fg}" stroke-width="{2 if heavy else 1}" stroke-linecap="square"/>'


def _row_markup(row, cols, ox=0, default_bg=DEFAULT_BG):
    """SVG for one terminal row, drawn at y = 0 (callers translate it with <use>)."""
    backs, shapes, lines, texts = [], [], [], {}
    resolved = []
    for x in range(cols):
        c = row[x]
        if c.reverse:
            bgc = _color(c.fg, DEFAULT_FG, default_bg)
            fg = _color(c.bg, default_bg, bgc)
            has_bg = True
        else:
            bgc = _color(c.bg, default_bg)
            fg = _color(c.fg, DEFAULT_FG, bgc)
            has_bg = c.bg != "default"
        resolved.append((c, fg, bgc if has_bg else None))
    run_start, run_color = 0, None
    for x in range(cols + 1):  # merge runs of the same background
        color = resolved[x][2] if x < cols else None
        if color != run_color:
            if run_color is not None:
                backs.append(f'<rect x="{ox + run_start * CW}" width="{(x - run_start) * CW}" height="{CH}" fill="{_hex(run_color)}"/>')
            run_start, run_color = x, color
    for x in range(cols):
        c, fg, _bg = resolved[x]
        ch = c.data
        if not ch or ch == " ":
            continue
        px = ox + x * CW
        fgx = _hex(fg)
        vec = _vector(ch, px, 0, fgx)
        if vec is not None:
            shapes.append(vec)
        else:
            key = (fgx, bool(c.bold), bool(c.italics))
            if len(ch.encode("utf-16-le")) != 2:  # astral / combined: position it on its own
                key += (px,)
            texts.setdefault(key, []).append((px, ch))
        if c.underscore:
            lines.append(f'<rect x="{px}" y="{CH - 3}" width="{CW}" height="1" fill="{fgx}"/>')
        if c.strikethrough:
            lines.append(f'<rect x="{px}" y="{CH // 2}" width="{CW}" height="1" fill="{fgx}"/>')
    for key, items in texts.items():
        fgx, bold, italic = key[:3]
        xs = " ".join(str(p) for p, _ in items)
        body = escape("".join(ch for _, ch in items), quote=False)
        attrs = f'fill="{fgx}"' + (' font-weight="700"' if bold else "") + (' font-style="italic"' if italic else "")
        shapes.append(f'<text x="{xs}" y="{BASELINE}" {attrs}>{body}</text>')
    return "".join(backs) + "".join(lines) + "".join(shapes)


def render_svg(frames, *, title="revcode", durations=None, last_hold=4.0, chrome=True, rows=None, cols=None, background=True, pad=16, first_row=0):
    """One <svg>. With several frames, plays them in a loop (the last one is held for `last_hold` s)."""
    cols = cols or len(frames[0].rows[0])
    rows = rows or max(f.last_row() for f in frames) + 1
    rows = rows - first_row
    top = 40 if chrome else 0
    width = cols * CW + 2 * pad
    height = top + rows * CH + 2 * pad
    ox, oy = pad, top + pad
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
        f'font-family="{FONT}" font-size="{FONT_SIZE}" role="img" aria-label="{escape(title)} terminal session">'
    ]
    n = len(frames)
    durations = list(durations or [1.5] * n)
    durations[-1] = max(durations[-1], last_hold) if n > 1 else durations[-1]
    total = sum(durations)
    if n > 1:
        css = [".f{opacity:0;animation-duration:%.2fs;animation-iteration-count:infinite;animation-timing-function:step-end}" % total]
        t = 0.0
        for i, d in enumerate(durations):
            a, b = 100 * t / total, 100 * (t + d) / total
            t += d
            css.append(f".f{i}{{animation-name:k{i}}}")
            stops = []
            if a > 0:
                stops.append("0%{opacity:0}")
            stops.append(f"{a:.3f}%{{opacity:1}}")
            if b < 100:
                stops.append(f"{b:.3f}%{{opacity:0}}")
            css.append(f"@keyframes k{i}{{{''.join(stops)}}}")
        css.append("@media (prefers-reduced-motion:reduce){.f{animation:none}.fl{opacity:1}}")
        parts.append("<style>" + "".join(css) + "</style>")
    if background:
        if chrome:
            parts.append(f'<rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="10" fill="{_hex(DEFAULT_BG)}" stroke="#3f3f46"/>')
            parts.append(f'<path d="M0.5,{top} L{width - 0.5},{top}" stroke="#27272a"/>')
            for i, color in enumerate(("#ff5f56", "#ffbd2e", "#27c93f")):
                parts.append(f'<circle cx="{22 + i * 20}" cy="{top // 2}" r="6" fill="{color}"/>')
            parts.append(f'<text x="{width // 2}" y="{top // 2 + 5}" fill="#71717a" font-family="{UI_FONT}" font-size="13" text-anchor="middle">{escape(title)}</text>')
        else:
            parts.append(f'<rect width="{width}" height="{height}" fill="{_hex(DEFAULT_BG)}"/>')
    defs, ids = [], {}

    def row_id(markup):
        if markup not in ids:
            ids[markup] = len(ids)
            defs.append(f'<g id="r{ids[markup]}">{markup}</g>')
        return ids[markup]

    groups = []
    for i, frame in enumerate(frames):
        uses = []
        for y in range(rows):
            markup = _row_markup(frame.rows[first_row + y], cols, ox)
            if markup:
                uses.append(f'<use href="#r{row_id(markup)}" y="{oy + y * CH}"/>')
        if frame.cursor:
            cx, cy = frame.cursor[0], frame.cursor[1] - first_row
            if 0 <= cy < rows and cx < cols:
                uses.append(f'<rect x="{ox + cx * CW}" y="{oy + cy * CH}" width="{CW}" height="{CH}" fill="#e4e4e7" fill-opacity="0.85"/>')
        body = "".join(uses)
        if n > 1:
            cls = f"f f{i}" + (" fl" if i == n - 1 else "")
            groups.append(f'<g class="{cls}">{body}</g>')
        else:
            groups.append(f"<g>{body}</g>")
    parts.append("<defs>" + "".join(defs) + "</defs>")
    parts.extend(groups)
    parts.append("</svg>")
    return "".join(parts)
