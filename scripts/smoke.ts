// Zero-token smoke test against the real pi CLI: start the RPC child and ask
// for its state. Catches framing, lifecycle and spawn-argument drift that the
// scripted fake child cannot.
import { ChildRpc } from "../rpc.ts";

const rpc = new ChildRpc({
	command: process.env.PI_CLI ?? "pi",
	args: ["--mode", "rpc", "--no-session"],
	cwd: process.cwd(),
	env: { ...process.env },
});

try {
	await rpc.start();
	const state = await rpc.send({ type: "get_state" });
	console.log(JSON.stringify(state));
} finally {
	await rpc.stop();
}
