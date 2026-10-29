"""Drive a command inside a real pty, emulate the terminal with pyte, and write PNG screenshots.

Usage (as a library):
    from ptyshot import Session
    s = Session(["node", "dist/revcode.mjs", ...], cols=100, rows=30, env={...}, cwd=...)
    s.wait(1.0); s.send("hello"); s.shot("a.png"); s.send_keys("enter"); s.close()
"""
import os, pty, select, signal, struct, fcntl, termios, time, sys
import pyte
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
KEYS = {
    "enter": "\r", "esc": "\x1b", "tab": "\t", "shift-tab": "\x1b[Z", "backspace": "\x7f",
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
    "home": "\x1b[H", "end": "\x1b[F", "delete": "\x1b[3~",
    "ctrl-a": "\x01", "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-e": "\x05", "ctrl-k": "\x0b",
    "ctrl-l": "\x0c", "ctrl-o": "\x0f", "ctrl-r": "\x12", "ctrl-u": "\x15", "ctrl-w": "\x17",
    "ctrl-j": "\n", "ctrl-y": "\x19", "alt-b": "\x1bb", "alt-f": "\x1bf", "alt-enter": "\x1b\r",
    "shift-enter": "\x1b[13;2u", "ctrl-left": "\x1b[1;5D", "ctrl-right": "\x1b[1;5C",
    "paste-start": "\x1b[200~", "paste-end": "\x1b[201~", "ctrl-z": "\x1a", "ctrl-_": "\x1f",
}
DEFAULT_FG = (212, 212, 212)
DEFAULT_BG = (24, 24, 27)
NAMED = {
    "black": (0, 0, 0), "red": (205, 49, 49), "green": (13, 188, 121), "brown": (229, 229, 16),
    "blue": (36, 114, 200), "magenta": (188, 63, 188), "cyan": (17, 168, 205), "white": (229, 229, 229),
    "brightblack": (102, 102, 102), "brightred": (241, 76, 76), "brightgreen": (35, 209, 139),
    "brightbrown": (245, 245, 67), "brightblue": (59, 142, 234), "brightmagenta": (214, 112, 214),
    "brightcyan": (41, 184, 219), "brightwhite": (255, 255, 255),
}

FAINT = "~dim"


class FaintScreen(pyte.Screen):
    """pyte drops SGR 2 (faint); RevCode uses it for muted text. Track it as a suffix on the fg name."""

    faint = False

    def select_graphic_rendition(self, *attrs):
        attrs = attrs or (0,)
        kept, i = [], 0
        while i < len(attrs):
            a = attrs[i]
            if a in (38, 48):  # extended color: keep its sub-parameters (a literal 2 there is not "faint")
                n = 3 if i + 1 < len(attrs) and attrs[i + 1] == 5 else 5
                kept.extend(attrs[i:i + n])
                i += n
                continue
            if a in (0, 22):
                self.faint = False
            if a == 2:
                self.faint = True
            else:
                kept.append(a)
            i += 1
        attrs = tuple(kept)
        if attrs:
            super().select_graphic_rendition(*attrs)
        cur = self.cursor.attrs
        fg = cur.fg[: -len(FAINT)] if cur.fg.endswith(FAINT) else cur.fg
        if self.faint:
            fg += FAINT
        if fg != cur.fg:
            self.cursor.attrs = cur._replace(fg=fg)


def _color(c, default, bg=None):
    if c.endswith(FAINT):
        base = _color(c[: -len(FAINT)], default)
        b = bg or DEFAULT_BG
        return tuple(int(base[i] * 0.55 + b[i] * 0.45) for i in range(3))
    if c == "default":
        return default
    if c in NAMED:
        return NAMED[c]
    if len(c) == 6:
        try:
            return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return default

class Session:
    def __init__(self, argv, cols=100, rows=30, env=None, cwd=None):
        self.cols, self.rows = cols, rows
        self.screen = FaintScreen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""
        pid, fd = pty.fork()
        if pid == 0:
            if cwd:
                os.chdir(cwd)
            e = dict(os.environ)
            e.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_US.UTF-8"})
            if env:
                e.update(env)
            os.execvpe(argv[0], argv, e)
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.status = None

    def pump(self, secs=0.3):
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.raw += data
                self.stream.feed(data)

    wait = pump

    def send(self, text, settle=0.25):
        os.write(self.fd, text.encode())
        self.pump(settle)

    def type(self, text, settle=0.25):
        self.send(text, settle)

    def key(self, *names, settle=0.25):
        for n in names:
            os.write(self.fd, KEYS[n].encode())
            self.pump(0.08)
        self.pump(settle)

    def resize(self, cols, rows):
        self.cols, self.rows = cols, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.screen.resize(rows, cols)
        os.kill(self.pid, signal.SIGWINCH)
        self.pump(0.4)

    def text(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def shot(self, path, cell=(9, 18), font_size=14):
        font = ImageFont.truetype(FONT, font_size)
        fontb = ImageFont.truetype(FONT_B, font_size)
        cw, ch = cell
        img = Image.new("RGB", (self.cols * cw + 8, self.rows * ch + 8), DEFAULT_BG)
        d = ImageDraw.Draw(img)
        for y in range(self.rows):
            line = self.screen.buffer[y]
            for x in range(self.cols):
                c = line[x]
                bg = _color(c.bg, DEFAULT_BG)
                fg = _color(c.fg, DEFAULT_FG, bg)
                if c.reverse:
                    fg, bg = bg, fg
                if c.bg != "default" or c.reverse:
                    d.rectangle([4 + x * cw, 4 + y * ch, 4 + (x + 1) * cw - 1, 4 + (y + 1) * ch - 1], fill=bg)
                if c.data.strip():
                    if getattr(c, "italics", False):
                        pass
                    col = tuple(int(v * 0.6) for v in fg) if False else fg
                    d.text((4 + x * cw, 4 + y * ch), c.data, font=fontb if c.bold else font, fill=col)
                if c.underscore:
                    d.line([4 + x * cw, 4 + (y + 1) * ch - 2, 4 + (x + 1) * cw - 1, 4 + (y + 1) * ch - 2], fill=fg)
        cx, cy = self.screen.cursor.x, self.screen.cursor.y
        if not self.screen.cursor.hidden:
            d.rectangle([4 + cx * cw, 4 + cy * ch, 4 + (cx + 1) * cw - 1, 4 + (cy + 1) * ch - 1], outline=(255, 255, 255))
        img.save(path)

    def close(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
