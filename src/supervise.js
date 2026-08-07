import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The worst failure mode in the system: the sender dies, the web tier keeps
// answering GET / so the platform health check stays green, and notifications
// silently stop flowing with nobody alerted. Taking the whole container down
// instead turns a silent outage into a restart.
export function superviseSender() {
  let stopping = false;

  const child = fork(path.join(__dirname, "sender.js"), [], {
    execArgv: ["--max-old-space-size=256"],
    stdio: "inherit",
  });

  console.log(JSON.stringify({ msg: "sender_forked", pid: child.pid }));

  child.on("exit", (code, signal) => {
    if (stopping) {
      console.log(JSON.stringify({ msg: "sender_stopped", code, signal }));
      return;
    }
    console.error(JSON.stringify({ msg: "sender_died", code, signal }));
    process.exit(1);
  });

  child.on("error", (err) => {
    console.error(JSON.stringify({ msg: "sender_fork_error", err: String(err) }));
    process.exit(1);
  });

  return {
    stop() {
      stopping = true;
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
