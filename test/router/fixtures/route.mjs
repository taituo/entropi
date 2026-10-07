import { readFileSync } from "node:fs";
const KEY = readFileSync(process.env.HOME + "/openrouter20usd.key", "utf8").trim();
const agents = [
  ["ops", "Investigates live systems: pods, logs, crash loops, restarts, metrics. Applies approved config changes."],
  ["developer", "Writes and fixes code in a sandbox, runs tests, prepares branches and patches."],
  ["reviewer", "Reviews changes and branches, approves or rejects with reasons. Does not write code."],
  ["insight", "Analyses data and metrics, makes charts, explains anomalies and trends."],
];
// [message, expected agent or "none"]
const cases0 = [
  ["tutki miksi checkout-api kaatuu koko ajan", "ops"],
  ["checkout-api crash-loops after the last deploy, what's wrong?", "ops"],
  ["käynnistä payments-pod uudelleen", "ops"],
  ["korjaa tämä bugi: pyöristys menee väärin laskutuksessa", "developer"],
  ["write a unit test for the retry logic and make it pass", "developer"],
  ["tee patch joka nostaa connection poolin kokoa", "developer"],
  ["voitko katsoa onko branch agent/fix-pool kunnossa ennen kuin se menee läpi", "reviewer"],
  ["review this diff please, is it safe to merge?", "reviewer"],
  ["hyväksy tai hylkää tämä muutos perusteluineen", "reviewer"],
  ["miksi latenssi nousi eilen illalla? piirrä kuvaaja", "insight"],
  ["show me the error-rate trend for the last 7 days", "insight"],
  ["onko tämä piikki poikkeama vai normaalia vaihtelua?", "insight"],
  ["moi, mitä kuuluu?", "none"],
  ["kiitos, hyvä!", "none"],
  ["what time is the meeting tomorrow?", "none"],
  ["tarvitsen jonkun joka tutkii kaatumisen ja korjaa sen", "ops"],
  ["check the logs and then fix the config", "ops"],
  ["tee kuvaaja ja kirjoita siitä raportti koodina", "insight"],
  ["lisää uusi endpoint /health ja testit", "developer"],
  ["voiko joku katsoa tämän ennen kuin ajan sen tuotantoon", "reviewer"],
];
const cases = JSON.parse(readFileSync(new URL("set.json", import.meta.url),"utf8")).filter(x=>x.exp!=="?multi").map(x=>[x.msg,x.exp]);
const sys = `You route chat messages to exactly one agent, or none. Agents:\n${agents.map(([h, d]) => `- ${h}: ${d}`).join("\n")}\nIf the message is small talk or fits no agent, answer "none". Reply with ONLY JSON: {"agent":"<handle|none>","confidence":<0..1>}`;
async function route(model, msg) {
  const t = Date.now();
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 2500, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: msg }] }) });
  const j = await r.json(); const ms = Date.now() - t;
  const txt = j.choices?.[0]?.message?.content ?? ""; let out;
  try { out = JSON.parse(txt.match(/\{[\s\S]*\}/)[0]); } catch { out = { agent: "?parse", confidence: 0 }; }
  return { agent: String(out.agent).toLowerCase(), conf: out.confidence, ms, err: j.error?.message, cost: j.usage?.cost };
}
for (const model of process.argv.slice(2)) {
  let ok = 0, ms = [], cost = 0, wrong = [];
  for (const [msg, exp] of cases) {
    const r = await route(model, msg);
    if (r.err) { console.log(model, "ERR", r.err.slice(0, 120)); break; }
    ms.push(r.ms); cost += r.cost ?? 0;
    if (r.agent === exp) ok++; else wrong.push(`"${msg.slice(0, 70)}" want ${exp} got ${r.agent}(${r.conf})`);
  }
  ms.sort((a, b) => a - b);
  console.log(`${model}: ${ok}/${cases.length}  p50 ${ms[ms.length >> 1]}ms  max ${ms.at(-1)}ms  cost $${cost.toFixed(5)}`);
  wrong.forEach((w) => console.log("   ✗", w));
}
