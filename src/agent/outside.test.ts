import os from "node:os";
import { describe, expect, it } from "vitest";
import { PermissionManager } from "./permissions.js";
import { reachesOutside, writtenPaths } from "./outside.js";

const ctx = { projectRoot: "/home/ana/shop", copyDir: "/home/ana/.revcode/universes/u1/work", home: "/home/ana" };
const check = (command: string) => reachesOutside(command, ctx);

describe("reachesOutside", () => {
  it("lets ordinary work in the copy through", () => {
    for (const command of [
      "npm test",
      "npm install lodash",
      "pytest -q 2>&1 | tail -20",
      "git status && git diff HEAD~1 -- src/",
      "git log --oneline -5; git blame src/app.ts",
      "git commit -am wip",
      "rm -rf build dist && mkdir -p out && cp src/a.ts out/",
      "echo hi > notes.txt && cat notes.txt >> /dev/null",
      "mktemp -d && touch /tmp/scratch.txt && rm -f /tmp/scratch.txt",
      "ln -s /usr/lib/libz.so vendor/libz.so",
      "cp ~/.npmrc.example .npmrc.example",
      "kill %1; kill $SERVER_PID; kill 4242",
      "node -e 'console.log(1 > 0)'",
      "cat /etc/os-release",
      `ls ${ctx.copyDir}/src`,
      "cd /home/ana/shop-docs && ls",
      "python3 -c \"print('a -> b')\"",
      "gh pr view 12 && gh api repos/o/r/pulls",
      "crontab -l",
    ]) {
      expect([command, check(command)]).toEqual([command, undefined]);
    }
  });

  it.each([
    ["git push origin main", "pushes to a git remote"],
    ["git -C . push --force", "pushes to a git remote"],
    ["make && git push", "pushes to a git remote"],
    ["gh pr create --fill", "changes something on GitHub"],
    ["gh api -X POST repos/o/r/issues -f title=x", "changes something on GitHub"],
    ["npm publish --access public", "publishes a package"],
    ["cargo publish", "publishes a package"],
    ["docker push ghcr.io/o/app:1", "pushes a container image"],
    ["kubectl apply -f k8s/", "deploys or changes cloud resources"],
    ["terraform apply -auto-approve", "deploys or changes cloud resources"],
    ["vercel --prod", "deploys or changes cloud resources"],
    ["aws s3 sync dist s3://bucket", "deploys or changes cloud resources"],
    ["sudo apt-get install -y jq", "runs as an administrator"],
    ["ssh deploy@prod 'systemctl restart app'", "connects to another machine"],
    ["rsync -a dist/ web@host:/srv/www", "connects to another machine"],
    ["npm install -g typescript", "installs software on your machine"],
    ["brew install ripgrep", "installs software on your machine"],
    ["pkill -f node", "stops programs by name"],
    ["crontab jobs.txt", "changes scheduled jobs on your machine"],
  ])("asks before %s", (command, reason) => {
    expect(check(command)).toBe(reason);
  });

  it("catches the real project folder and writes elsewhere on disk", () => {
    expect(check("cd /home/ana/shop && npm test")).toBe("uses your real project folder instead of the copy");
    expect(check("cat /home/ana/shop/package.json")).toBe("uses your real project folder instead of the copy");
    expect(check("echo 'alias x=y' >> ~/.bashrc")).toBe("changes files outside the project (~/.bashrc)");
    expect(check("rm -rf /var/www/html")).toBe("changes files outside the project (/var/www/html)");
    expect(check("cp build/app /usr/local/bin/app")).toBe("changes files outside the project (/usr/local/bin/app)");
    expect(check('mv "$HOME/old" ./')).toBe("changes files outside the project ($HOME/old)");
    expect(check("dd if=img.bin of=/dev/sdb")).toBeUndefined(); // /dev writes are the catastrophic list's job
  });

  it("extracts written paths from redirections and file commands", () => {
    expect(writtenPaths("a > out.txt; b 2>> err.log && FOO=1 tee -a log1 log2 | x")).toEqual(["out.txt", "err.log", "log1", "log2"]);
    expect(writtenPaths("cp -r src dst && ln -sf target link && touch a b")).toEqual(["dst", "link", "a", "b"]);
    expect(writtenPaths("cmd 2>&1")).toEqual([]);
  });

  it("allows the system temp directory", () => {
    expect(check(`echo x > ${os.tmpdir()}/rc-test.txt`)).toBeUndefined();
  });
});

describe("permissions in a universe", () => {
  const outsideCheck = (tool: string, args: Record<string, unknown>) => (tool === "shell" ? check(String(args.command)) : undefined);

  it("runs work in the copy without asking but asks before reaching outside", () => {
    const pm = new PermissionManager({ mode: "yolo", outsideCheck });
    expect(pm.evaluate("shell", { command: "npm test" })).toEqual({ action: "allow" });
    expect(pm.evaluate("write_file", { path: "a.ts" })).toEqual({ action: "allow" });
    expect(pm.evaluate("shell", { command: "git push" })).toMatchObject({ action: "ask", outside: true, reason: "This reaches outside the copy: it pushes to a git remote." });
  });

  it("an allow rule still wins", () => {
    const pm = new PermissionManager({ mode: "yolo", outsideCheck, allow: ["shell(git push*)"] });
    expect(pm.evaluate("shell", { command: "git push origin main" }).action).toBe("allow");
  });

  it("refuses with a clear reason when nobody can approve", async () => {
    const pm = new PermissionManager({ mode: "yolo", outsideCheck });
    const decision = await pm.middleware().before!({ call: { id: "1", name: "shell", arguments: { command: "git push origin main" } } } as never);
    expect(decision).toMatchObject({ allow: false });
    expect((decision as { reason: string }).reason).toContain('--allow "shell(git push*)"');
  });

  it("asks the user, who can allow it", async () => {
    const asked: string[] = [];
    const pm = new PermissionManager({ mode: "yolo", outsideCheck, approver: async (req) => (asked.push(req.reason), "allow") });
    const decision = await pm.middleware().before!({ call: { id: "1", name: "shell", arguments: { command: "sudo ls" } } } as never);
    expect(decision).toMatchObject({ allow: true });
    expect(asked).toEqual(["This reaches outside the copy: it runs as an administrator."]);
  });
});
