/** A recording `Ui` for tests: captures printed rows and answers modals from a script. */

import type { PromptRequest, SelectRequest, Ui, UiInput } from "../tui/ui.js";

export class FakeUi implements Ui {
  readonly interactive: boolean;
  readonly echoesInput = false;
  columns = 100;
  printed: string[] = [];
  tail: string | undefined;
  busy = false;
  tools: string[] = [];
  tokens = 0;
  hints: string[] = [];
  selects: SelectRequest[] = [];
  prompts: PromptRequest[] = [];
  raw: string[] = [];
  refreshes = 0;
  cleared = 0;
  inputText = "";
  private selectAnswers: Array<number | undefined> = [];
  private promptAnswers: Array<string | undefined> = [];

  constructor(options: { interactive?: boolean } = {}) {
    this.interactive = options.interactive ?? true;
  }

  answerSelect(...answers: Array<number | undefined>): this {
    this.selectAnswers.push(...answers);
    return this;
  }

  answerPrompt(...answers: Array<string | undefined>): this {
    this.promptAnswers.push(...answers);
    return this;
  }

  /** Everything printed so far as one string. */
  text(): string {
    return this.printed.join("\n");
  }

  mount(): void {}
  unmount(): void {}
  async nextInput(): Promise<UiInput> {
    return { type: "eof" };
  }
  print(text: string): void {
    this.printed.push(text);
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
  }
  hint(text: string): void {
    this.hints.push(text);
  }
  setNote(): void {}
  thought: string | undefined;
  toolOutput: string | undefined;
  setThought(text: string | undefined): void {
    this.thought = text;
  }
  setToolOutput(text: string | undefined): void {
    this.toolOutput = text;
  }
  beginTool(id: string, label: string): void {
    this.tools.push(`${id}:${label}`);
  }
  endTool(id: string): void {
    this.tools = this.tools.filter((t) => !t.startsWith(`${id}:`));
  }
  addTokens(n: number): void {
    this.tokens += n;
  }
  setTail(text: string | undefined): void {
    this.tail = text;
  }
  refresh(): void {
    this.refreshes += 1;
  }
  async select(request: SelectRequest): Promise<number | undefined> {
    this.selects.push(request);
    return this.selectAnswers.shift();
  }
  async prompt(request: PromptRequest): Promise<string | undefined> {
    this.prompts.push(request);
    return this.promptAnswers.shift();
  }
  notify(): void {}
  clearScreen(): void {
    this.cleared += 1;
  }
  modalMs(): number {
    return 0;
  }
  rawWrite(sequence: string): void {
    this.raw.push(sequence);
  }
  setInputText(text: string): void {
    this.inputText = text;
  }
}
