/**
 * implement-expression-evaluator — a parser with precedence, associativity and
 * bracket-matching rules that all have to line up.
 *
 * The traps are the ones the README lists outright: right-associative `^`,
 * unary minus binding looser than `^` but allowed in an exponent, int-vs-float
 * results, three bracket kinds that must match, and which error class each kind
 * of bad input raises. No `eval`-style shortcut satisfies the error cases.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, pass, pythonCode, withScratchCopy, writeFiles } from "../helpers.js";

const README = `# calc.py

A tiny arithmetic expression evaluator.

    evaluate(expression: str) -> int | float
    is_balanced(text: str) -> bool

## Syntax

* Numbers are decimal literals with digits before any dot: \`7\`, \`3.14\`, \`0.5\`.
  Not allowed: \`.5\`, \`5.\`, exponents (\`1e3\`), underscores, signs inside the literal.
* Binary operators \`+ - * / ^\`, where \`^\` is exponentiation.
* Precedence, tightest first: \`^\`, then unary minus, then \`* /\`, then \`+ -\`.
* \`^\` is right-associative: \`2^3^2\` is 512. Unary minus binds looser than \`^\`, so
  \`-2^2\` is -4, but an exponent may itself be negated: \`2^-1\` is 0.5.
  \`* / + -\` are left-associative. Unary minus may repeat (\`--3\` is 3) and may follow
  another operator (\`2*-3\`). There is no unary plus.
* Grouping brackets are \`()\`, \`[]\` and \`{}\`. They are interchangeable for grouping
  but each must be closed by its own kind: \`2*[3+{4-(1)}]\` is fine, \`[1+2)\` is not.
* Spaces and tabs are ignored between tokens but may not split a number (\`1 2\` is an
  error). There is no implicit multiplication: \`2(3)\` and \`(1)(2)\` are errors.

## Results

* \`/\` is true division: \`7/2\` is 3.5.
* If the final result is a whole number it is returned as an \`int\` (\`6/3\` is \`2\`,
  \`0.5*4\` is \`2\`, \`1.5+1.5\` is \`3\`); otherwise it is a \`float\`.
* Dividing by zero (\`1/0\`, \`1/(2-2)\`, \`0^-1\`) raises \`ZeroDivisionError\`.
* \`0^0\` is 1.
* Every other malformed input raises \`ValueError\`: an empty or blank expression,
  unknown characters, a dangling operator (\`1+\`, \`*2\`, \`1+*2\`), empty brackets \`()\`,
  and unmatched or mismatched brackets.

## is_balanced

\`is_balanced(text)\` is True exactly when every \`( ) [ ] { }\` in \`text\` is closed by
its matching kind in the right nesting order. All other characters are ignored, and
the empty string is balanced. It never raises.
`;

const STUB = `"""Arithmetic expression evaluator. The specification is in README.md."""


def evaluate(expression):
    raise NotImplementedError("see README.md")


def is_balanced(text):
    raise NotImplementedError("see README.md")
`;

const REFERENCE = String.raw`"""Arithmetic expression evaluator. The specification is in README.md."""

import re

_TOKEN = re.compile(r"\s*(?:(\d+(?:\.\d+)?)|(.))")
_OPEN = {"(": ")", "[": "]", "{": "}"}
_CLOSE = {v: k for k, v in _OPEN.items()}


def _tokenize(expression):
    tokens = []
    position = 0
    text = expression.rstrip()
    while position < len(text):
        match = _TOKEN.match(text, position)
        number, char = match.groups()
        position = match.end()
        if number is not None:
            tokens.append(("num", number))
        elif char in "+-*/^" or char in _OPEN or char in _CLOSE:
            tokens.append(("op", char))
        else:
            raise ValueError(f"unexpected character {char!r}")
    return tokens


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.index = 0

    def peek(self):
        return self.tokens[self.index] if self.index < len(self.tokens) else (None, None)

    def take(self):
        token = self.peek()
        self.index += 1
        return token

    def expression(self):
        value = self.term()
        while self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            right = self.term()
            value = value + right if op == "+" else value - right
        return value

    def term(self):
        value = self.unary()
        while self.peek() in (("op", "*"), ("op", "/")):
            op = self.take()[1]
            right = self.unary()
            if op == "*":
                value = value * right
            else:
                if right == 0:
                    raise ZeroDivisionError("division by zero")
                value = value / right
        return value

    def unary(self):
        if self.peek() == ("op", "-"):
            self.take()
            return -self.unary()
        return self.power()

    def power(self):
        base = self.atom()
        if self.peek() == ("op", "^"):
            self.take()
            exponent = self.unary_exponent()
            if base == 0 and exponent < 0:
                raise ZeroDivisionError("zero to a negative power")
            return base ** exponent
        return base

    def unary_exponent(self):
        if self.peek() == ("op", "-"):
            self.take()
            return -self.unary_exponent()
        return self.power()

    def atom(self):
        kind, value = self.take()
        if kind == "num":
            return float(value) if "." in value else int(value)
        if kind == "op" and value in _OPEN:
            if self.peek() == ("op", _OPEN[value]):
                raise ValueError("empty brackets")
            inner = self.expression()
            closing = self.take()
            if closing != ("op", _OPEN[value]):
                raise ValueError("mismatched brackets")
            return inner
        raise ValueError("unexpected token")


def evaluate(expression):
    parser = _Parser(_tokenize(expression))
    if not parser.tokens:
        raise ValueError("empty expression")
    value = parser.expression()
    if parser.index != len(parser.tokens):
        raise ValueError("unexpected trailing input")
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def is_balanced(text):
    stack = []
    for char in text:
        if char in _OPEN:
            stack.append(_OPEN[char])
        elif char in _CLOSE:
            if not stack or stack.pop() != char:
                return False
    return not stack
`;

type Expect = { value: number; type: "int" | "float" } | { error: "ValueError" | "ZeroDivisionError" };

const ok = (value: number, type: "int" | "float"): Expect => ({ value, type });
const bad = (error: "ValueError" | "ZeroDivisionError"): Expect => ({ error });

const EVAL_CASES: Array<[string, Expect]> = [
  ["1+2*3", ok(7, "int")],
  ["(1+2)*3", ok(9, "int")],
  ["2^3^2", ok(512, "int")],
  ["-2^2", ok(-4, "int")],
  ["2^-1", ok(0.5, "float")],
  ["2^-2", ok(0.25, "float")],
  ["--3", ok(3, "int")],
  ["7/2", ok(3.5, "float")],
  ["6/3", ok(2, "int")],
  ["0.5*4", ok(2, "int")],
  ["1.5+1.5", ok(3, "int")],
  ["10-4-3", ok(3, "int")],
  ["100/10/5", ok(2, "int")],
  ["2*[3+{4-(1)}]", ok(12, "int")],
  [" 1 +\t2 ", ok(3, "int")],
  ["2 * -3", ok(-6, "int")],
  ["4/-2", ok(-2, "int")],
  ["-2*-3", ok(6, "int")],
  ["-(2+3)", ok(-5, "int")],
  ["-(-(4))", ok(4, "int")],
  ["2^(1+1)", ok(4, "int")],
  ["0^0", ok(1, "int")],
  ["-3^2 + 10", ok(1, "int")],
  ["2^3*2", ok(16, "int")],
  ["2*3^2", ok(18, "int")],
  ["3.14*2", ok(6.28, "float")],
  ["1/3", ok(1 / 3, "float")],
  ["0.1+0.2", ok(0.3, "float")],
  ["((((((((((((((((((((7))))))))))))))))))))", ok(7, "int")],
  ["", bad("ValueError")],
  ["   ", bad("ValueError")],
  ["1+", bad("ValueError")],
  ["*2", bad("ValueError")],
  ["1+*2", bad("ValueError")],
  ["()", bad("ValueError")],
  ["(1+2", bad("ValueError")],
  ["1+2)", bad("ValueError")],
  ["[1+2)", bad("ValueError")],
  ["(1+2]", bad("ValueError")],
  ["{1+2}}", bad("ValueError")],
  ["1 2", bad("ValueError")],
  ["2(3)", bad("ValueError")],
  ["(1)(2)", bad("ValueError")],
  ["1..2", bad("ValueError")],
  [".5", bad("ValueError")],
  ["5.", bad("ValueError")],
  ["1e3", bad("ValueError")],
  ["+3", bad("ValueError")],
  ["abc", bad("ValueError")],
  ["2 $ 3", bad("ValueError")],
  ["1_000", bad("ValueError")],
  ["3 ^", bad("ValueError")],
  ["1/0", bad("ZeroDivisionError")],
  ["1/(2-2)", bad("ZeroDivisionError")],
  ["5/0.0", bad("ZeroDivisionError")],
  ["0^-1", bad("ZeroDivisionError")],
];

const BALANCE_CASES: Array<[string, boolean]> = [
  ["", true],
  ["()", true],
  ["([]{})", true],
  ["(]", false],
  ["((", false],
  ["))", false],
  ["a(b[c]d)e", true],
  ["([)]", false],
  ["{[()()]}", true],
  ["}{", false],
  ["no brackets at all", true],
  ["(", false],
  ["x]", false],
  ["<>", true],
];

/** Crudely drop docstrings and comments so prose like "no eval()" doesn't trip the guard. */
function codeOnly(source: string): string {
  return source.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, "").replace(/#.*$/gm, "");
}

const PROBE = (cases: unknown, balance: unknown): string => String.raw`
import json
import calc

def classify(exc):
    if isinstance(exc, ZeroDivisionError):
        return "ZeroDivisionError"
    if isinstance(exc, ValueError):
        return "ValueError"
    return type(exc).__name__

out = {"eval": [], "balanced": []}
for expression in json.loads(${JSON.stringify(JSON.stringify(cases))}):
    try:
        value = calc.evaluate(expression)
        out["eval"].append({"value": value, "type": type(value).__name__})
    except BaseException as exc:
        out["eval"].append({"error": classify(exc)})
for text in json.loads(${JSON.stringify(JSON.stringify(balance))}):
    try:
        out["balanced"].append(calc.is_balanced(text))
    except BaseException as exc:
        out["balanced"].append("raised " + type(exc).__name__)
print(json.dumps(out))
`;

export const implementExpressionEvaluator: DynoTask = {
  id: "implement-expression-evaluator",
  title: "Implement an expression evaluator and bracket matcher from a spec",
  category: "implement",
  difficulty: 3,
  instruction:
    "`README.md` describes a small arithmetic evaluator, `calc.py`, with two functions: `evaluate()` and `is_balanced()`. " +
    "Right now `calc.py` is just a stub. Implement it exactly as specified — operator precedence and associativity, the " +
    "three bracket kinds, int-versus-float results and which exception each kind of bad input raises. Write the parser " +
    "yourself rather than handing the string to Python's `eval`. I'll test it against plenty of expressions you haven't seen.",
  maxIterations: 35,
  timeoutSec: 200,

  setup(dir) {
    writeFiles(dir, { "README.md": README, "calc.py": STUB });
  },

  async grade(dir) {
    const source = fs.existsSync(path.join(dir, "calc.py")) ? fs.readFileSync(path.join(dir, "calc.py"), "utf8") : "";
    if (/\b(?:eval|exec)\s*\(/.test(codeOnly(source))) {
      return fail("calc.py must contain its own parser (no eval/exec)");
    }
    return withScratchCopy(dir, async (scratch) => {
      const probe = PROBE(
        EVAL_CASES.map(([expression]) => expression),
        BALANCE_CASES.map(([text]) => text),
      );
      const result = await pythonCode(probe, { cwd: scratch, timeoutMs: 30_000 });
      if (result.timedOut) return fail("evaluation timed out (infinite loop?)");
      if (result.code !== 0) return fail(`probe crashed: ${clip(result.stderr, 400)}`);
      const output = JSON.parse(result.stdout) as {
        eval: Array<{ value?: number; type?: string; error?: string }>;
        balanced: Array<boolean | string>;
      };

      const problems: string[] = [];
      EVAL_CASES.forEach(([expression, expected], index) => {
        const actual = output.eval[index] ?? {};
        if ("error" in expected) {
          if (actual.error !== expected.error) {
            problems.push(`${JSON.stringify(expression)} should raise ${expected.error}, got ${actual.error ?? `${String(actual.value)} (${String(actual.type)})`}`);
          }
        } else if (
          actual.error !== undefined ||
          actual.type !== expected.type ||
          typeof actual.value !== "number" ||
          Math.abs(actual.value - expected.value) > 1e-9
        ) {
          problems.push(`${JSON.stringify(expression)} should be ${expected.value} (${expected.type}), got ${actual.error ?? `${String(actual.value)} (${String(actual.type)})`}`);
        }
      });
      BALANCE_CASES.forEach(([text, expected], index) => {
        if (output.balanced[index] !== expected) {
          problems.push(`is_balanced(${JSON.stringify(text)}) should be ${expected}, got ${String(output.balanced[index])}`);
        }
      });
      if (problems.length > 0) return fail(`${problems.length} wrong: ${clip(problems.slice(0, 3).join("; "), 450)}`);
      return pass(`${EVAL_CASES.length} expressions and ${BALANCE_CASES.length} bracket checks correct`);
    });
  },

  oracle(dir) {
    fs.writeFileSync(path.join(dir, "calc.py"), REFERENCE);
  },
};
