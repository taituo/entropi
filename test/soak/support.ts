// Shared helpers for the soak suite (test/soak/*.soak.ts).
// No model URLs, keys or other secrets here or in any soak output: only shapes and sizes are logged.
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const obs = (label: string, v: unknown) => console.log(`OBS ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

/** Full durations unless shortened for iteration, e.g. SOAK_PARALLEL_MINUTES=3. */
export const soakMinutes = (name: string, def: number) => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : def;
};

export const tmpDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
export const LIM = 100_000;
/** All messages in a space: listMessages defaults to the newest 200, which a soak overflows. */
export const msgs = (core: any, space = "incidents", viewer = "human:anna") =>
	core.listMessages("main", space, viewer, LIM) as any[];
export const agentMsgs = (core: any, space = "incidents") => msgs(core, space).filter((m: any) => m.kind === "agent");
export const rssMb = () => process.memoryUsage().rss / 1048576;
export const fdCount = () => {
	try {
		return (spawnSync("ls", ["/proc/self/fd"], { encoding: "utf8" }).stdout.match(/\S+/g) ?? []).length;
	} catch {
		return -1;
	}
};
export const fileMb = (p: string) => {
	try {
		return statSync(p).size / 1048576;
	} catch {
		return -1;
	}
};
export const eventCount = (core: any, realm = "main") => (core.db.prepare("SELECT COUNT(*) n FROM events WHERE realm_id = ?").get(realm) as any).n as number;

export type ResSnap = { rssMb: number; fds: number; coreDbMb: number; memDbMb: number; events: number };
export function snapResources(core: any, coreDb: string, memDb: string): ResSnap {
	return { rssMb: rssMb(), fds: fdCount(), coreDbMb: fileMb(coreDb), memDbMb: fileMb(memDb), events: eventCount(core) };
}
export function obsDelta(label: string, before: ResSnap, after: ResSnap) {
	obs(label, {
		rssMb: [round1(before.rssMb), round1(after.rssMb), `+${round1(after.rssMb - before.rssMb)}`],
		fds: [before.fds, after.fds, `+${after.fds - before.fds}`],
		coreDbMb: [round1(before.coreDbMb), round1(after.coreDbMb)],
		memDbMb: [round1(before.memDbMb), round1(after.memDbMb)],
		events: [before.events, after.events, `+${after.events - before.events}`],
	});
}
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Newest local entropi-sandbox image tag, or "" when podman has none. */
export function resolveSandboxImage(): string {
	if (process.env.SANDBOX_TEST_IMAGE) return process.env.SANDBOX_TEST_IMAGE;
	const out = spawnSync("podman", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" }).stdout;
	const tags = out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("localhost/entropi-sandbox:")).sort();
	return tags.at(-1) ?? "";
}

// ---------------------------------------------------------------------------
// Deterministic long-text corpus: Finnish and English prose, code, JSON, emoji.
// ---------------------------------------------------------------------------

const FI = [
	"Käyttökatko alkoi yöllä, kun varmenne vanheni tuotantoklusterissa.",
	"SRE päivysti ja huomasi, että yhteyspoolin koko oli nollassa.",
	"Korjaus vietiin katselmoinnin kautta, ja se otettiin käyttöön aamulla.",
	"Tapahtuman juurisyy kirjattiin muistiin myöhempää tarkastelua varten.",
	"Valvonta hälytti ensin viiveestä, sitten virheiden kasvusta.",
	"Palautus tehtiin edelliseen tunnettuun hyvään versioon.",
	"Tiimi sopi, että seuraavalla kerralla esto on automaattinen.",
	"Raportti lähetettiin katselmoijalle ennen käyttöönottoa.",
];
const EN = [
	"The nightly export failed intermittently before the on-call noticed.",
	"We bisected the deploy history and found the bad migration.",
	"The pool size was zero, so every checkout request timed out.",
	"Approval gates exist so live systems never change silently.",
	"Dashboards showed the spike minutes before the first page.",
	"The fix went through review and rolled out region by region.",
	"Memory trees keep the durable facts; transcripts keep everything.",
	"Steering joins a run in progress instead of queueing behind it.",
];
const CODE = `def diagnose(pool_size: int, errors: list[str]) -> dict:
    """Return a minimal remediation plan for a crashing service."""
    plan = {"restart": False, "escalate": False, "notes": []}
    if pool_size <= 0:
        plan["restart"] = True
        plan["notes"].append("POOL_SIZE must be > 0")
    for e in errors:
        if "cert" in e.lower():
            plan["escalate"] = True
    return plan

// queue depth guard
function healthy(depth: number, threshold = 120): boolean {
  return depth < threshold;
}
`;
const EMOJI = "🚨📊🔧🧪📦🔒⚠️✅❌🔁🧠💾🌐🔍📝🚀🛡️🐳📉📈🧵🔑🧰";

export function shortText(i: number): string {
	const lang = i % 2 ? "fi" : "en";
	const s = lang === "fi" ? FI[i % FI.length] : EN[i % EN.length];
	return lang === "fi" ? `Kierros ${i}: ${s} Vastaa yhdellä lauseella.` : `Round ${i}: ${s} Answer in one sentence.`;
}
export function codeText(i: number): string {
	return `Round ${i}: review this snippet and describe what it does in two sentences.\n\`\`\`\n${CODE}\n// case ${i}\n\`\`\``;
}
export function jsonText(i: number): string {
	const o: Record<string, unknown> = { round: i, service: "checkout-api", poolSize: i % 7, tags: ["soak", `r${i % 13}`], nested: { a: [1, 2, 3], b: { c: `case-${i}` } } };
	return `Round ${i}: summarise these fields in one sentence: ${JSON.stringify(o)}`;
}
export function emojiText(i: number): string {
	return `Kierros ${i}: ${EMOJI} Kerro yhdellä lauseella, mistä tässä voisi olla kyse. ${EMOJI}`;
}
/** Exactly n chars: mixed Finnish/English prose, code, JSON and emoji. */
export function longText(n: number, seed: number): string {
	const parts: string[] = [`SOAK-LONG-${seed} (${n} chars):`];
	let k = 0;
	while (parts.join("\n").length < n) {
		parts.push(FI[k % FI.length], EN[k % EN.length], CODE, JSON.stringify({ k, v: `v${k}`, arr: [k, k + 1, k + 2] }), EMOJI);
		k++;
	}
	const s = parts.join("\n");
	return s.length <= n ? s.padEnd(n, ".") : s.slice(0, n);
}
