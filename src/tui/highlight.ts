/**
 * Small, dependency-free syntax highlighter for fenced code blocks and diffs.
 *
 * It is a line-at-a-time lexer with a little carried state (block comments, triple-quoted
 * and template strings), good enough to make code scannable — keywords, strings, numbers,
 * comments, types — without pulling in a parser per language.
 */

import type { Role, Style } from "./style.js";

export interface Highlighter {
  /** Highlight one line (no trailing newline); state carries to the next call. */
  line(text: string): string;
}

interface LangDef {
  keywords: ReadonlySet<string>;
  literals?: ReadonlySet<string>;
  lineComments?: readonly string[];
  blockComment?: readonly [string, string];
  quotes: readonly string[];
  triple?: boolean;
  caseInsensitive?: boolean;
  /** Capitalized identifiers are types/classes. */
  types?: boolean;
  variables?: boolean;
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

const JS: LangDef = {
  keywords: words(
    "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
  ),
  literals: words("true false null undefined NaN Infinity"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'", "`"],
  types: true,
};

const PY: LangDef = {
  keywords: words(
    "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
  ),
  literals: words("True False None self cls"),
  lineComments: ["#"],
  quotes: ['"', "'"],
  triple: true,
  types: true,
};

const SH: LangDef = {
  keywords: words("if then else elif fi for while until do done case esac in function select time return exit break continue export local readonly unset source alias set"),
  literals: words("true false"),
  lineComments: ["#"],
  quotes: ['"', "'"],
  variables: true,
};

const GO: LangDef = {
  keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
  literals: words("true false nil iota"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'", "`"],
  types: true,
};

const RUST: LangDef = {
  keywords: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
  literals: words("true false None Some Ok Err"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  types: true,
};

const C: LangDef = {
  keywords: words(
    "auto break case catch char class const constexpr continue default delete do double else enum explicit extern float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while",
  ),
  literals: words("true false NULL nullptr"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  types: true,
};

const JAVA: LangDef = {
  keywords: words(
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while var record",
  ),
  literals: words("true false null"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  types: true,
};

const RUBY: LangDef = {
  keywords: words("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield"),
  literals: words("true false nil"),
  lineComments: ["#"],
  quotes: ['"', "'"],
  types: true,
};

const SQL: LangDef = {
  keywords: words(
    "select from where and or not insert into values update set delete create table alter drop index join left right inner outer full on group by order having limit offset as distinct union all case when then else end primary key foreign references default null is in like between exists count sum avg min max with",
  ),
  literals: words("true false null"),
  lineComments: ["--"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  caseInsensitive: true,
};

const CSS: LangDef = {
  keywords: words("@media @import @keyframes @font-face @supports @layer !important"),
  lineComments: [],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
};

const YAML: LangDef = {
  keywords: words(""),
  literals: words("true false null yes no on off"),
  lineComments: ["#"],
  quotes: ['"', "'"],
};

const LANGS: Record<string, LangDef> = {
  js: JS,
  javascript: JS,
  jsx: JS,
  mjs: JS,
  cjs: JS,
  ts: JS,
  typescript: JS,
  tsx: JS,
  json: { keywords: words(""), literals: words("true false null"), quotes: ['"'] },
  jsonc: { ...JS, keywords: words(""), types: false },
  py: PY,
  python: PY,
  sh: SH,
  bash: SH,
  zsh: SH,
  shell: SH,
  console: SH,
  go: GO,
  golang: GO,
  rs: RUST,
  rust: RUST,
  c: C,
  h: C,
  cpp: C,
  "c++": C,
  cc: C,
  hpp: C,
  cs: JAVA,
  csharp: JAVA,
  java: JAVA,
  kt: JAVA,
  kotlin: JAVA,
  swift: JAVA,
  rb: RUBY,
  ruby: RUBY,
  sql: SQL,
  css: CSS,
  scss: CSS,
  yaml: YAML,
  yml: YAML,
  toml: YAML,
  ini: YAML,
  php: { ...JS, lineComments: ["//", "#"] },
};

export function supportedLanguage(lang: string | undefined): boolean {
  if (!lang) return false;
  const key = lang.toLowerCase();
  return key in LANGS || key === "diff" || key === "patch" || key === "html" || key === "xml" || key === "svg";
}

export function createHighlighter(lang: string | undefined, style: Style): Highlighter | undefined {
  if (!lang || !style.color) return undefined;
  const key = lang.toLowerCase();
  if (key === "diff" || key === "patch") return diffHighlighter(style);
  if (key === "html" || key === "xml" || key === "svg") return markupHighlighter(style);
  const def = LANGS[key];
  if (!def) return undefined;
  return lexer(def, key, style);
}

function diffHighlighter(style: Style): Highlighter {
  return {
    line(text) {
      if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) return style.bold(style.dim(text));
      if (text.startsWith("@@")) return style.paint("accent", text);
      if (text.startsWith("+")) return style.paint("diffAdd", text);
      if (text.startsWith("-")) return style.paint("diffDel", text);
      return text;
    },
  };
}

function markupHighlighter(style: Style): Highlighter {
  let inComment = false;
  return {
    line(text) {
      if (inComment) {
        const end = text.indexOf("-->");
        if (end === -1) return style.dim(text);
        inComment = false;
        return style.dim(text.slice(0, end + 3)) + this.line(text.slice(end + 3));
      }
      const start = text.indexOf("<!--");
      if (start !== -1) {
        const end = text.indexOf("-->", start + 4);
        if (end === -1) {
          inComment = true;
          return this.line(text.slice(0, start)) + style.dim(text.slice(start));
        }
        return this.line(text.slice(0, start)) + style.dim(text.slice(start, end + 3)) + this.line(text.slice(end + 3));
      }
      return text
        .replace(/("[^"]*"|'[^']*')/g, (m) => style.paint("ok", m))
        .replace(/(<\/?)([A-Za-z][\w:-]*)/g, (_m, open: string, tag: string) => `${open}${style.paint("heading", tag)}`)
        .replace(/(\s)([A-Za-z_:][\w:.-]*)(=)/g, (_m, sp: string, attr: string, eq: string) => `${sp}${style.paint("accent", attr)}${eq}`);
    },
  };
}

function lexer(def: LangDef, lang: string, style: Style): Highlighter {
  let inBlock = false;
  let inTriple: string | undefined;
  let inTemplate = false;
  const isJson = lang === "json";
  const isYaml = lang === "yaml" || lang === "yml" || lang === "toml" || lang === "ini";
  const paint = (role: Role, text: string): string => style.paint(role, text);
  const comment = (text: string): string => style.dim(text);

  return {
    line(text) {
      let out = "";
      let i = 0;
      const n = text.length;

      if (isYaml && !inTriple) {
        const key = /^(\s*(?:-\s+)?)([\w.\-"' /]+?)(\s*[:=])(\s|$)/.exec(text);
        if (key && !text.trimStart().startsWith("#")) {
          out += key[1] + paint("accent", key[2]) + key[3] + key[4];
          i = key[0].length;
        }
      }

      while (i < n) {
        if (inBlock) {
          const end = text.indexOf(def.blockComment?.[1] ?? "", i);
          if (end === -1) return out + comment(text.slice(i));
          out += comment(text.slice(i, end + def.blockComment![1].length));
          i = end + def.blockComment![1].length;
          inBlock = false;
          continue;
        }
        if (inTriple) {
          const end = text.indexOf(inTriple, i);
          if (end === -1) return out + paint("ok", text.slice(i));
          out += paint("ok", text.slice(i, end + 3));
          i = end + 3;
          inTriple = undefined;
          continue;
        }
        if (inTemplate) {
          let j = i;
          while (j < n && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
          if (j >= n) return out + paint("ok", text.slice(i));
          out += paint("ok", text.slice(i, j + 1));
          i = j + 1;
          inTemplate = false;
          continue;
        }

        const rest = text.slice(i);
        const c = text[i];

        const lineComment = def.lineComments?.find((marker) => rest.startsWith(marker));
        if (lineComment && !(lineComment === "#" && lang !== "py" && /^#\w/.test(rest) && isCLike(lang))) {
          return out + comment(rest);
        }
        if (def.blockComment && rest.startsWith(def.blockComment[0])) {
          const end = text.indexOf(def.blockComment[1], i + def.blockComment[0].length);
          if (end === -1) {
            inBlock = true;
            return out + comment(rest);
          }
          out += comment(text.slice(i, end + def.blockComment[1].length));
          i = end + def.blockComment[1].length;
          continue;
        }

        if (def.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
          const quote = rest.slice(0, 3);
          const end = text.indexOf(quote, i + 3);
          if (end === -1) {
            inTriple = quote;
            return out + paint("ok", rest);
          }
          out += paint("ok", text.slice(i, end + 3));
          i = end + 3;
          continue;
        }

        if (def.quotes.includes(c)) {
          if (c === "`" && !def.quotes.includes("`")) {
            out += c;
            i += 1;
            continue;
          }
          let j = i + 1;
          while (j < n && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
          if (j >= n) {
            if (c === "`") {
              inTemplate = true;
              return out + paint("ok", rest);
            }
            // Unterminated quote on this line (an apostrophe in prose, a continued string): paint to the end.
            out += paint("ok", rest);
            return out;
          }
          const literal = text.slice(i, j + 1);
          const afterQuote = text.slice(j + 1);
          const isKey = isJson && /^\s*:/.test(afterQuote);
          out += paint(isKey ? "accent" : "ok", literal);
          i = j + 1;
          continue;
        }

        if (def.variables && c === "$") {
          const variable = /^\$(?:\{[^}]*\}|\(|[A-Za-z_]\w*|[0-9@#?*!$-])/.exec(rest);
          if (variable) {
            out += paint("accent", variable[0]);
            i += variable[0].length;
            continue;
          }
        }

        if (/[0-9]/.test(c) && !/[\w.]/.test(text[i - 1] ?? "")) {
          const num = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[a-zA-Z%]{0,3})/.exec(rest);
          if (num) {
            out += paint("warn", num[0]);
            i += num[0].length;
            continue;
          }
        }

        if (/[A-Za-z_$@]/.test(c)) {
          const ident = /^[@$]?[A-Za-z_][\w$]*(?:-[A-Za-z_][\w]*)*/.exec(rest);
          if (ident) {
            const word = ident[0];
            const probe = def.caseInsensitive ? word.toLowerCase() : word;
            if (def.keywords.has(probe)) out += paint("heading", word);
            else if (def.literals?.has(word)) out += paint("warn", word);
            else if (def.types && /^[A-Z][A-Za-z0-9_]*$/.test(word) && word.length > 1 && /[a-z]/.test(word)) out += paint("accent", word);
            else if (word.startsWith("@") && def.types) out += paint("accent", word);
            else out += word;
            i += word.length;
            continue;
          }
        }

        out += c;
        i += 1;
      }
      return out;
    },
  };
}

function isCLike(lang: string): boolean {
  return ["c", "h", "cpp", "c++", "cc", "hpp", "cs", "csharp", "java", "go", "rs", "rust", "css", "scss"].includes(lang);
}
