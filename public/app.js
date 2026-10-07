import { html, render, useState, useEffect, useRef, useMemo } from "/vendor/preact.js";

const api = async (path, opts = {}) => {
	const res = await fetch(path, {
		method: opts.body ? "POST" : "GET",
		headers: { "content-type": "application/json", "x-requested-with": "entropi" },
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
	if (res.status === 401) return (location.href = "/auth/login");
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || res.statusText);
	return data;
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const initials = (n) => n.split(/\s+/).filter((w) => /^\p{L}/u.test(w)).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
const time = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Small, safe markdown: everything is escaped first, then fences, code, bold and mentions are added back. */
function md(src, agentIds) {
	const parts = esc(src).split(/```(?:\w*)\n?/);
	return parts
		.map((p, i) => {
			if (i % 2) {
				const lines = p.replace(/\n$/, "").split("\n").map((l) => (/^\+(?!\+)/.test(l) ? `<span class="add">${l}</span>` : /^-(?!-)/.test(l) ? `<span class="del">${l}</span>` : l));
				return `<pre>${lines.join("\n")}</pre>`;
			}
			return p
				.replace(/`([^`\n]+)`/g, "<code>$1</code>")
				.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
				.replace(/@([a-zA-Z][\w-]*)/g, (m, id) => (agentIds.has(id.toLowerCase()) ? `<span class="mention">${m}</span>` : m));
		})
		.join("");
}


const PALETTE = ["#111", "#555", "#777", "#999", "#333", "#bbb"];
const fmtX = (x, timeAxis) => (timeAxis ? new Date(x).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : String(x));
const fmtY = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : Number.isInteger(v) ? String(v) : v.toFixed(1));

function Chart({ c }) {
	const [hover, setHover] = useState(null);
	const W = 640, H = 230, L = 46, R = 14, T = 12, B = 26;
	const first = c.series[0]?.points || [];
	if (!first.length) return html`<div class="card">${c.title}: no data</div>`;
	const timeAxis = first.every((p) => typeof p.x === "number");
	const cats = timeAxis ? null : [...new Set(c.series.flatMap((s) => s.points.map((p) => String(p.x))))];
	const xs = c.series.flatMap((s) => s.points.map((p) => p.x));
	const xmin = timeAxis ? Math.min(...xs) : 0, xmax = timeAxis ? Math.max(...xs) : cats.length;
	const bar = c.type === "bar";
	const xp = (x) => {
		if (timeAxis) return L + ((x - xmin) / (xmax - xmin || 1)) * (W - L - R);
		return L + ((cats.indexOf(String(x)) + 0.5) / cats.length) * (W - L - R);
	};
	const ys = c.series.flatMap((s) => s.points.map((p) => p.y));
	const ymin = bar || c.type === "area" ? Math.min(0, ...ys) : Math.min(...ys), yhi = Math.max(...ys);
	const ymax = yhi + (yhi - ymin || 1) * 0.08;
	const yp = (y) => T + (1 - (y - ymin) / (ymax - ymin || 1)) * (H - T - B);
	const ticks = Array.from({ length: 5 }, (_, i) => ymin + ((ymax - ymin) * i) / 4);
	const xTicks = timeAxis ? Array.from({ length: 5 }, (_, i) => xmin + ((xmax - xmin) * i) / 4) : cats.filter((_, i) => cats.length <= 8 || i % Math.ceil(cats.length / 8) === 0);
	const band = (W - L - R) / (timeAxis ? first.length : cats.length);
	const bw = Math.max(2, (band * 0.7) / c.series.length);
	const onMove = (e) => {
		const r = e.currentTarget.getBoundingClientRect();
		const px = ((e.clientX - r.left) / r.width) * W;
		let best = 0, bd = 1e9;
		first.forEach((p, i) => { const d = Math.abs(xp(p.x) - px); if (d < bd) { bd = d; best = i; } });
		setHover(best);
	};
	const hp = hover != null ? first[hover] : null;
	return html`<div class="chart">
		<div class="chart-title">${c.title}${c.unit ? html` <span class="unit">(${c.unit})</span>` : ""}</div>
		<svg viewBox=${`0 0 ${W} ${H}`} onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
			${ticks.map((t) => html`<g><line x1=${L} x2=${W - R} y1=${yp(t)} y2=${yp(t)} class="grid" /><text x=${L - 6} y=${yp(t) + 4} text-anchor="end" class="axis">${fmtY(t)}</text></g>`)}
			${xTicks.map((t, i) => html`<text x=${xp(t)} y=${H - 8} text-anchor=${timeAxis && i === xTicks.length - 1 ? "end" : "middle"} class="axis">${fmtX(t, timeAxis)}</text>`)}
			${c.series.map((s, si) => {
				const col = PALETTE[si % PALETTE.length];
				if (bar) return s.points.map((p) => html`<rect x=${xp(p.x) - (bw * c.series.length) / 2 + si * bw} y=${yp(Math.max(p.y, 0))} width=${bw - 1} height=${Math.abs(yp(p.y) - yp(0))} fill=${col} rx="1.5" />`);
				const d = s.points.map((p, i) => `${i ? "L" : "M"}${xp(p.x).toFixed(1)},${yp(p.y).toFixed(1)}`).join("");
				return html`<g>${c.type === "area" && html`<path d=${`${d}L${xp(s.points[s.points.length - 1].x)},${yp(Math.max(ymin, 0))}L${xp(s.points[0].x)},${yp(Math.max(ymin, 0))}Z`} fill=${col} opacity="0.16" />`}<path d=${d} fill="none" stroke=${col} stroke-width="2" stroke-linejoin="round" /></g>`;
			})}
			${hp && html`<line x1=${xp(hp.x)} x2=${xp(hp.x)} y1=${T} y2=${H - B} class="cursor-line" />`}
			${hp && c.series.map((s, si) => s.points[hover] && !bar && html`<circle cx=${xp(s.points[hover].x)} cy=${yp(s.points[hover].y)} r="3.5" fill=${PALETTE[si % PALETTE.length]} />`)}
		</svg>
		<div class="legend">${c.series.map((s, si) => html`<span><i style=${{ background: PALETTE[si % PALETTE.length] }}></i>${s.name}${hp && s.points[hover] ? html`: <b>${fmtY(s.points[hover].y)}${c.unit ? " " + c.unit : ""}</b>` : ""}</span>`)}${hp && html`<span class="when">${fmtX(hp.x, timeAxis)}</span>`}</div>
	</div>`;
}


const TONE = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", muted: "var(--muted)", accent: "var(--accent)" };
const tcol = (t) => (t ? TONE[t] : undefined);
const SB = { ok: "✓", warn: "!", bad: "✕", unknown: "?" };

/** Renders a validated json-render-style spec using only these components. */
function UiNode({ spec, id, onAction }) {
	const el = spec.elements[id];
	if (!el) return null;
	const p = el.props || {};
	const kids = (el.children || []).map((c) => html`<${UiNode} key=${c} spec=${spec} id=${c} onAction=${onAction} />`);
	switch (el.type) {
		case "Stack": return html`<div class=${"ui-stack " + (p.direction === "row" ? "row" : "")}>${kids}</div>`;
		case "Card": return html`<div class="ui-card">${p.title && html`<div class="ui-title">${p.title}</div>`}${p.subtitle && html`<div class="ui-sub">${p.subtitle}</div>`}${kids}</div>`;
		case "Text": return html`<div class="ui-text" style=${{ color: tcol(p.tone), fontWeight: p.bold ? 650 : 400 }}>${p.text}</div>`;
		case "Badge": return html`<span class="chip" style=${{ color: tcol(p.tone), borderColor: tcol(p.tone) }}>${p.text}</span>`;
		case "Stat": return html`<div class="ui-stat"><div class="ui-sub">${p.label}</div><div class="ui-big" style=${{ color: tcol(p.tone) }}>${p.value}${p.unit && html`<span class="ui-unit">${p.unit}</span>`}${p.trend && html`<span class="ui-trend">${{ up: "▲", down: "▼", flat: "■" }[p.trend]}</span>`}</div></div>`;
		case "KeyValue": return html`<dl class="kv ui-kv">${p.items.map((i) => html`<dt>${i.key}</dt><dd>${i.value}</dd>`)}</dl>`;
		case "Progress": return html`<div class="ui-progress">${p.label && html`<div class="ui-sub">${p.label} · ${p.value}/${p.max}</div>`}<div class="bar"><i style=${{ width: Math.max(0, Math.min(100, (p.value / (p.max || 100)) * 100)) + "%", background: tcol(p.tone) || "var(--accent)" }}></i></div></div>`;
		case "StatusBoard": return html`<div class="ui-sb">${p.items.map((i) => html`<div class=${"sbi " + i.status}><span class="sbdot">${SB[i.status]}</span><div><b>${i.name}</b>${i.detail && html`<div class="ui-sub">${i.detail}</div>`}</div></div>`)}</div>`;
		case "Timeline": return html`<div class="ui-tl">${p.events.map((e) => html`<div class="tle"><i style=${{ background: tcol(e.tone) || "var(--accent)" }}></i><div><span class="ui-sub">${e.time}</span> <b>${e.title}</b>${e.detail && html`<div class="ui-sub">${e.detail}</div>`}</div></div>`)}</div>`;
		case "Table": return html`<${DataTable} t=${{ title: "", columns: p.columns, rows: p.rows }} />`;
		case "Chart": return html`<${Chart} c=${{ kind: "chart", title: p.title || "", type: p.type, unit: p.unit, series: p.series }} />`;
		case "Button": return html`<button class="btn ui-btn" onClick=${() => onAction(p.action)}>${p.label}</button>`;
		default: return null;
	}
}
function UiView({ spec, onAction }) {
	return html`<div class="chart ui-root"><${UiNode} spec=${spec} id=${spec.root} onAction=${onAction} /></div>`;
}

function DataTable({ t }) {
	return html`<div class="chart"><div class="chart-title">${t.title}</div>
		<div class="tablewrap"><table><thead><tr>${t.columns.map((c) => html`<th>${c}</th>`)}</tr></thead>
		<tbody>${t.rows.map((r) => html`<tr>${r.map((v) => html`<td>${v}</td>`)}</tr>`)}</tbody></table></div></div>`;
}

function Avatar({ agent, name, human }) {
	return html`<div class=${"avatar" + (human ? " human" : "")}>${initials(name)}</div>`;
}

function Activity({ items }) {
	if (!items?.length) return null;
	const running = items.filter((a) => a.status === "running").length;
	return html`<details class="activity" open=${running > 0}>
		<summary>${running ? `Working… ${items.length} step${items.length > 1 ? "s" : ""}` : `${items.length} step${items.length > 1 ? "s" : ""}`}</summary>
		${items.map(
			(a) => html`<div class="act" key=${a.id}>
				<div class="row">
					<span class=${"st-" + a.status}>${a.status === "running" ? "●" : a.status === "done" ? "✓" : "✕"}</span>
					<span class="name">${a.name}</span><span class="args">${a.args}</span>
				</div>
				${a.preview && html`<details><summary style="cursor:pointer;color:var(--muted);font-size:12px">result</summary><pre>${a.preview}</pre></details>`}
			</div>`,
		)}
	</details>`;
}


const RANK = { viewer: 0, operator: 1, approver: 2, admin: 3 };
const permsOf = (roles) => {
	const r = Math.max(-1, ...roles.map((x) => RANK[x] ?? -1));
	return { admin: r >= 3, approve: r >= 2, operate: r >= 1, post: r >= 1 };
};
const STATUS_CLASS = (m) => (m.meta.status === "open" ? "pending" : m.meta.status === "decided" ? (m.meta.answer === m.meta.options?.[0] ? "approved" : "rejected") : "rejected");

function DecisionCard({ m, me, onDecide }) {
	const d = m.meta.context || {};
	const status = m.meta.status;
	const options = m.meta.options || ["approve", "reject"];
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const decide = async (answer) => {
		setBusy(true);
		try { await onDecide(m.meta.decisionId, answer, note); } finally { setBusy(false); }
	};
	const label = { decided: "Decided", cancelled: "Cancelled", expired: "Expired" }[status];
	return html`<div class="msg"><${Avatar} name=${m.authorName} agent=${me.agentsById[m.authorId]} />
		<div class="body">
			<div class="meta"><b>${m.authorName}</b><span class="role">agent</span><time>${time(m.createdAt)}</time></div>
			<div class=${"card " + STATUS_CLASS(m)}>
				<h5>Decision needed${m.meta.urgency === "high" ? " · urgent" : ""}</h5>
				<div class="title">${m.text}</div>
				<dl class="kv">
					${d.target && html`<dt>Target</dt><dd>${d.target}</dd>`}
					${d.restart && html`<dt>Then</dt><dd>restart ${d.restart}</dd>`}
					${d.reason && html`<dt>Reason</dt><dd>${d.reason}</dd>`}
					${d.changes?.length && html`<dt>Changes</dt><dd class="change">${d.changes.map((c) => html`<div>${c.key}: <span class="from">${String(c.from)}</span> → <span class="to">${String(c.to)}</span></div>`)}</dd>`}
				</dl>
				${status === "open"
					? me.canDecide(m)
						? html`<input placeholder="Note (optional)" value=${note} onInput=${(e) => setNote(e.target.value)} style="width:100%;margin-bottom:8px;background:var(--bg);border:var(--border-thin);border-radius:var(--radius);padding:6px 8px;color:var(--text)" />
							<div class="actions">${options.map((o, i) => html`<button class=${"btn " + (i === 0 ? "approve" : "reject")} disabled=${busy} onClick=${() => decide(o)}>${o[0].toUpperCase() + o.slice(1)}</button>`)}</div>`
						: html`<div class="needs-approver">Waiting for someone with the <b>${m.meta.requiredAuthority}</b> role. You are signed in as <b>${me.roleLabel}</b>.</div>`
					: html`<div class=${"verdict " + STATUS_CLASS(m)}>${label}${m.meta.answer ? `: ${m.meta.answer}` : ""}${m.meta.decidedBy ? ` by ${m.meta.decidedBy}` : ""}${m.meta.note ? ` — ${m.meta.note}` : ""}</div>`}
			</div>
		</div></div>`;
}

function CaseCard({ m }) {
	const src = { alert: "Opened automatically by an alert", agent: "Opened by an agent", manual: "Opened by a person" }[m.meta.source] || "";
	return html`<div class="card case"><h5>Case${src ? ` · ${src}` : ""}</h5><div class="title">${m.text}</div></div>`;
}

function Message({ m, me, agentIds, onDecide, onAction }) {
	if (m.kind === "case") return html`<div class="msg" style="max-width:760px"><${CaseCard} m=${m} /></div>`;
	if (m.kind === "notice") return html`<div class="notice">${m.text}</div>`;
	if (m.kind === "decision") return html`<${DecisionCard} m=${m} me=${me} onDecide=${onDecide} />`;
	if (m.kind === "delegation") return html`<div class="deleg"><div class="head"><b>${m.authorName}</b> asked <b>@${m.meta.to}</b></div><div class="text" dangerouslySetInnerHTML=${{ __html: md(m.text, agentIds) }}></div></div>`;
	const agent = me.agentsById[m.authorId];
	const human = !agent;
	const working = m.status === "working";
	const current = [...(m.meta.activity || [])].reverse().find((a) => a.status === "running");
	return html`<div class="msg"><${Avatar} agent=${agent} name=${m.authorName} human=${human} />
		<div class="body">
			<div class="meta"><b>${m.authorName}</b>${!human && html`<span class="role">agent</span>`}<time>${time(m.createdAt)}</time></div>
			${!human && html`<${Activity} items=${m.meta.activity} />`}
			${working && !m.text && html`<div class="status"><span class="dot working"></span> ${m.authorName} is working${current ? html` — running <code>${current.name}</code>` : ""}…</div>`}
			${(m.meta.images || []).length > 0 && html`<div class="atts">${m.meta.images.map((a) => html`<a href=${me.R("/files/" + a.id)} target="_blank" rel="noopener"><img class="att" src=${me.R("/files/" + a.id)} alt=${a.name} loading="lazy" /></a>`)}</div>`}
			${(m.meta.artifacts || []).map((a) => (a.kind === "chart" ? html`<${Chart} c=${a} />` : a.kind === "ui" ? html`<${UiView} spec=${a.spec} onAction=${onAction} />` : html`<${DataTable} t=${a} />`))}
			${m.text && html`<div class=${"text" + (working ? " cursor" : "")} dangerouslySetInnerHTML=${{ __html: md(m.text, agentIds) }}></div>`}
		</div></div>`;
}

function Composer({ space, agents, canPost, onSend, R, busy: agentBusy }) {
	const [text, setText] = useState("");
	const [sel, setSel] = useState(0);
	const [files, setFiles] = useState([]);
	const [busy, setBusy] = useState(0);
	const [err, setErr] = useState("");
	const [steer, setSteer] = useState(false);
	const ta = useRef();
	const picker = useRef();
	const m = /(?:^|\s)@([\w-]*)$/.exec(text);
	const options = m ? agents.filter((a) => a.handle.startsWith(m[1].toLowerCase())) : [];
	const pick = (a) => { setText(text.replace(/@[\w-]*$/, `@${a.handle} `)); setSel(0); ta.current?.focus(); };
	const upload = async (list) => {
		for (const f of [...list].filter((x) => x.type.startsWith("image/")).slice(0, 4 - files.length)) {
			setBusy((n) => n + 1); setErr("");
			try {
				const r = await fetch(R(`/spaces/${space.id}/upload?name=${encodeURIComponent(f.name || "pasted-image.png")}`), { method: "POST", headers: { "x-requested-with": "entropi", "content-type": "application/octet-stream" }, body: f });
				const d = await r.json();
				if (!r.ok) throw new Error(d.error || r.statusText);
				setFiles((cur) => [...cur, d.attachment]);
			} catch (e) { setErr(e.message); }
			setBusy((n) => n - 1);
		}
	};
	const canSend = canPost && busy === 0 && (text.trim() || files.length);
	const send = () => { if (canSend) { onSend(text.trim(), files.map((f) => f.id), agentBusy && steer ? "steer" : undefined); setText(""); setFiles([]); } };
	useEffect(() => { const t = ta.current; if (t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; } }, [text]);
	useEffect(() => { setFiles([]); setErr(""); }, [space.id]);
	return html`<div class="composer" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); if (canPost) upload(e.dataTransfer.files); }}>
		${options.length > 0 && html`<div class="suggest">${options.map((a, i) => html`<button class=${i === sel ? "sel" : ""} onMouseDown=${(e) => { e.preventDefault(); pick(a); }}><${Avatar} agent=${a} name=${a.name} /> <span><b>@${a.handle}</b> <span style="color:var(--muted)">${a.profile.title || ""}</span></span></button>`)}</div>`}
		${(files.length > 0 || busy > 0) && html`<div class="previews">${files.map((f) => html`<div class="prev"><img src=${R("/files/" + f.id)} alt=${f.name} /><button title="Remove" onClick=${() => setFiles((c) => c.filter((x) => x.id !== f.id))}>×</button></div>`)}${busy > 0 && html`<div class="prev loading">…</div>`}</div>`}
		<div class="box">
			<button class="attach" title="Attach an image (or paste / drop one)" disabled=${!canPost} onClick=${() => picker.current.click()}>📎</button>
			<input ref=${picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange=${(e) => { upload(e.target.files); e.target.value = ""; }} />
			<textarea ref=${ta} rows="1" disabled=${!canPost} value=${text}
				placeholder=${canPost ? (space.kind === "dm" ? `Message ${space.name} privately` : `Message #${space.name} — mention an agent with @`) : "You cannot post here"}
				onInput=${(e) => setText(e.target.value)}
				onPaste=${(e) => { const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/")); if (imgs.length) { e.preventDefault(); upload(imgs); } }}
				onKeyDown=${(e) => {
					if (options.length && (e.key === "Tab" || e.key === "Enter")) { e.preventDefault(); return pick(options[sel % options.length]); }
					if (options.length && e.key === "ArrowDown") { e.preventDefault(); return setSel((sel + 1) % options.length); }
					if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
				}} />
			${agentBusy && html`<button class=${"mode" + (steer ? " on" : "")} title="An agent is working. Queue: it answers after the current run. Steer: your message joins the run in progress." onClick=${() => setSteer(!steer)}>${steer ? "↪ steer now" : "queue"}</button>`}
			<button class="send" disabled=${!canSend} onClick=${send}>Send</button>
		</div>
		<div class="hint">${err ? html`<span style="color:var(--bad)">${err}</span>` : space.kind === "dm" ? `Only you can see this chat. ${space.name} answers every message.` : "Agents only act when mentioned. Shift+Enter for a new line. Paste or drop images to share them."}</div>
	</div>`;
}

function MemTree({ R, spaceId, agent, canOperate, caps, onFlash }) {
	const [info, setInfo] = useState(null);
	const [busy, setBusy] = useState(false);
	const load = () => api(R(`/spaces/${spaceId}/agents/${agent.handle}/memtree`)).then(setInfo).catch(() => setInfo({ unavailable: true }));
	const compact = async () => {
		setBusy(true);
		try {
			const r = await api(R(`/spaces/${spaceId}/agents/${agent.handle}/compact`), { body: {} });
			onFlash(r.compacted ? "Compacted: the agent's context now starts with the compressed memory view" : "Nothing to compact yet (the history is shorter than the kept tail)");
			load();
		} catch (e) { onFlash(e.message); }
		setBusy(false);
	};
	return html`<details class="mt" onToggle=${(e) => e.target.open && load()}>
		<summary>Memory tree</summary>
		${info?.unavailable && html`<div class="ui-sub">No model runtime is connected.</div>`}
		${info && !info.unavailable && html`<div class="ui-sub">${info.leaves} messages · ${info.nodes} summaries (${info.llmNodes} by model, ${info.pending} pending) · view ${info.view.length} lines, ≤ ${info.viewBytes} B</div>
			<div class="mtview">${info.view.slice(-40).map((l) => html`<div class="mtl"><code>${l.id}</code> <span class="ui-sub">${l.msgs > 1 ? l.msgs + " msgs" : l.role}</span> ${l.text}</div>`)}</div>`}
		${canOperate && caps.compact && html`<button class="btn small" disabled=${busy} onClick=${compact}>${busy ? "Compacting…" : "Compact now"}</button>`}
	</details>`;
}

function AgentCard({ a, presence, R, spaceId, canOperate, caps, onStop, onFlash }) {
	const p = presence[a.id] || { state: "idle" };
	const status = p.state === "waiting" ? "waiting_approval" : p.state === "working" ? "working" : "idle";
	const label = { idle: "Idle", working: "Working", waiting_approval: "Waiting for a decision" }[status];
	return html`<details class="agentcard">
		<summary><div class="top"><${Avatar} agent=${a} name=${a.name} /><div><b>${a.name}</b><span>${a.profile.title || ""} · <span class=${"dot " + status} style="display:inline-block"></span> ${label}</span></div></div></summary>
		<ul>${(a.profile.can || []).map((c) => html`<li class="can">${c}</li>`)}${(a.profile.cannot || []).map((c) => html`<li class="cannot">${c}</li>`)}</ul>
		${caps.memtree && html`<${MemTree} R=${R} spaceId=${spaceId} agent=${a} canOperate=${canOperate} caps=${caps} onFlash=${onFlash} />`}
		${canOperate && caps.stop && status !== "idle" && html`<button class="btn stopbtn" onClick=${() => onStop(a)}>Stop</button>`}
	</details>`;
}

/** NOW / NEEDS YOU / WORKING / BACKGROUND, compiled by the core. Everything that is fine is only a count. */
function FocusPanel({ focus, open }) {
	if (!focus) return null;
	const nothing = !focus.needsYou.length && !focus.attention.length && !focus.working.length && !focus.waiting.length;
	return html`<div class="ctx-pin">
		<h3>Needs you ${focus.needsYou.length ? html`<span class="badge">${focus.needsYou.length}</span>` : ""}</h3>
		${focus.needsYou.length === 0 ? html`<div class="empty">Nothing needs you.</div>` : focus.needsYou.map((n) => html`<div class="apitem" key=${n.decision.id}>
			<b>${n.decision.question}</b>${n.decision.urgency === "high" && html` <span class="chip">urgent</span>`}
			${n.spaceId && html`<div><button class="btn" onClick=${() => open(n.spaceId)}>Open #${n.spaceId}</button></div>`}</div>`)}
		${focus.attention.length > 0 && html`<h3>Needs attention</h3>${focus.attention.map((a) => html`<div class="note" key=${a.id}><span class=${"chip " + (a.kind === "failure" ? "st-failed" : "")}>${a.kind}</span> ${a.summary}</div>`)}`}
		${focus.working.length > 0 && html`<h3>Working</h3>${focus.working.map((w) => html`<div class="note" key=${w.id}>${w.title}${w.phase ? html` <span class="chip">${w.phase}</span>` : ""}</div>`)}`}
		${focus.background.count > 0 && html`<div class="empty">${focus.background.count} more queued in the background.</div>`}
		${nothing && focus.background.count === 0 && html`<div class="empty">You're caught up.</div>`}
	</div>`;
}

function App() {
	const [me, setMe] = useState(null);
	const [spaceId, setSpaceId] = useState(location.hash.slice(1) || "general");
	const [messages, setMessages] = useState([]);
	const [presence, setPresence] = useState({});
	const [spaces, setSpaces] = useState([]);
	const [focus, setFocus] = useState(null);
	const [newCase, setNewCase] = useState(null);
	const [showArchived, setShowArchived] = useState(false);
	const [toast, setToast] = useState("");
	const [usage, setUsage] = useState(undefined);
	const [navOpen, setNavOpen] = useState(false);
	const [sandboxes, setSandboxes] = useState([]);
	const tl = useRef();
	const stick = useRef(true);
	const spaceRef = useRef(spaceId);
	spaceRef.current = spaceId;
	const realmRef = useRef("");

	const flash = (t) => { setToast(t); setTimeout(() => setToast(""), 3500); };
	const R = (p) => `/api/realms/${realmRef.current}${p}`;
	const loadMessages = (id) => api(R(`/spaces/${id}/messages`)).then((d) => spaceRef.current === id && setMessages(d.messages)).catch(() => {});
	const loadFocus = () => api(R("/focus")).then((d) => setFocus(d.focus)).catch(() => {});

	useEffect(() => {
		(async () => {
			const who = await api("/api/me");
			realmRef.current = who.defaultRealm;
			const d = await api(R(""));
			const agents = d.actors.filter((a) => a.kind === "agent").map((a) => ({ ...a, handle: a.id.split(":").pop(), profile: a.profile || {}, color: a.profile?.color, title: a.profile?.title }));
			const roles = d.me.roles, perms = permsOf(roles);
			setMe({
				user: { name: d.me.name, id: d.me.id }, brand: who.brand, realm: d.realm, agents, agentsById: Object.fromEntries(agents.map((a) => [a.id, a])), perms,
				roleLabel: perms.admin ? "admin" : perms.approve ? "approver" : perms.operate ? "operator" : "viewer",
				caps: d.capabilities,
				canDecide: (m) => perms.approve && (m.meta.requiredAuthority !== "admin" || perms.admin),
				R,
			});
			setPresence(Object.fromEntries(d.presence.map((p) => [p.actorId, p])));
			setSpaces(d.spaces);
			document.title = who.brand.name;
			// Wireframe is the default look: the brand colour stays in data,
			// it must not leak into the UI. A later theme layer may opt in.
			loadFocus();
			// Only what the connected runtime and host support is asked for, and later shown.
			const caps = d.capabilities;
			if (caps.sandboxes) { const loadSbx = () => !document.hidden && api(R("/sandboxes")).then((x) => setSandboxes(x.sandboxes)).catch(() => {}); loadSbx(); setInterval(loadSbx, 15000); }
			if (perms.approve && caps.usage) api(R("/usage")).then((u) => setUsage(u.usage)).catch(() => setUsage(null)); else setUsage(perms.approve ? null : undefined);
		})();
	}, []);

	useEffect(() => { setNavOpen(false); location.hash = spaceId; if (realmRef.current) loadMessages(spaceId); stick.current = true; }, [spaceId, me]);

	useEffect(() => {
		if (!me) return;
		// The browser reconnects by itself and sends Last-Event-ID, so nothing that happened while offline is lost.
		const es = new EventSource(R("/events"));
		const upsert = (message) => setMessages((cur) => {
			if (message.spaceId !== spaceRef.current) return cur;
			const i = cur.findIndex((x) => x.id === message.id);
			if (i < 0) return [...cur, message].sort((a, b) => a.id - b.id);
			if (cur[i].updatedAt > message.updatedAt) return cur;
			const next = cur.slice(); next[i] = message; return next;
		});
		es.addEventListener("message", (e) => upsert(JSON.parse(e.data).message));
		es.addEventListener("presence", (e) => { const p = JSON.parse(e.data).presence; if (p) setPresence((cur) => ({ ...cur, [p.actorId]: p })); });
		es.addEventListener("space", (e) => { const s = JSON.parse(e.data).space; setSpaces((cur) => (cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [...cur, s])); });
		es.addEventListener("decision", loadFocus);
		es.addEventListener("event", (e) => { const t = JSON.parse(e.data).type; if (t.startsWith("work.") || t.startsWith("attention.")) loadFocus(); });
		return () => es.close();
	}, [me]);

	useEffect(() => { if (stick.current && tl.current) tl.current.scrollTop = tl.current.scrollHeight; }, [messages]);

	const agentIds = useMemo(() => new Set((me?.agents || []).map((a) => a.handle)), [me]);
	if (!me) return html`<div style="padding:40px;color:var(--muted)">Loading…</div>`;

	const open = spaces.filter((c) => c.status === "open");
	const space = spaces.find((c) => c.id === spaceId) || open[0] || { id: "general", name: "general", topic: "", agents: [], kind: "standing", status: "open" };
	const spAgents = (space.agentIds || []).map((id) => me.agentsById[id]).filter(Boolean);
	const go = (s) => { setSpaces((cur) => (cur.some((c) => c.id === s.id) ? cur : [...cur, s])); setSpaceId(s.id); };
	const createCase = async (e) => {
		e.preventDefault();
		const v = (newCase || "").trim();
		if (!v) return;
		try { const d = await api(R("/spaces"), { body: { topic: v } }); setNewCase(null); go(d.space); } catch (err) { flash(err.message); }
	};
	const openDm = (handle) => api(R("/dms"), { body: { agent: handle } }).then((d) => go(d.space)).catch((err) => flash(err.message));
	const send = (text, attachments = [], mode) => { stick.current = true; return api(R(`/spaces/${space.id}/messages`), { body: { text, attachments, mode } }).catch((e) => flash(e.message)); };
	const stop = (a) => api(R(`/spaces/${space.id}/agents/${a.handle}/stop`), { body: {} }).then((r) => flash(r.stopped ? "Stopped" : "Nothing was running")).catch((e) => flash(e.message));
	const decide = (id, answer, note) => api(R(`/decisions/${id}/decide`), { body: { answer, note } }).then(loadFocus).catch((e) => flash(e.message));
	const archive = (id, on) => api(R(`/spaces/${id}/${on ? "archive" : "reopen"}`), { body: {} }).catch((err) => flash(err.message));
	const pending = (focus?.needsYou || []).reduce((m, n) => ((m[n.spaceId] = (m[n.spaceId] || 0) + 1), m), {});
	const status = (a) => (presence[a.id]?.state === "waiting" ? "waiting_approval" : presence[a.id]?.state === "working" ? "working" : "idle");

	return html`<div class="shell">
		<aside class=${"side" + (navOpen ? " navopen" : "")}>
			<div class="brand"><div class="logo"><div class="mark">◆</div>${me.brand.name}</div><div class="ws">${me.realm.name}</div></div>
			<div class="side-scroll">
			<div class="section"><h4>Channels</h4>
				${open.filter((c) => c.kind === "standing").map((c) => html`<button class=${"item" + (c.id === space.id ? " active" : "")} onClick=${() => setSpaceId(c.id)}>
					<span class="hash">#</span>${c.name}${pending[c.id] ? html`<span class="badge">${pending[c.id]}</span>` : ""}</button>`)}
			</div>
			<div class="section"><h4>Cases <button class="plus" title="New case from a topic" onClick=${() => setNewCase(newCase === null ? "" : null)}>＋</button></h4>
				${newCase !== null && html`<form class="newcase" onSubmit=${createCase}><input autofocus placeholder="Topic or ticket" value=${newCase} onInput=${(e) => setNewCase(e.target.value)} /></form>`}
				${open.filter((c) => c.kind === "case").map((c) => html`<button class=${"item" + (c.id === space.id ? " active" : "")} onClick=${() => setSpaceId(c.id)} title=${c.topic}>
					<span class="hash">◆</span><span class="cname">${c.name}</span>${pending[c.id] ? html`<span class="badge">${pending[c.id]}</span>` : ""}</button>`)}
				${open.filter((c) => c.kind === "case").length === 0 && newCase === null && html`<div class="empty" style="padding:2px 10px">No open cases.</div>`}
				${spaces.some((c) => c.status === "archived") && html`<button class="item muted" onClick=${() => setShowArchived(!showArchived)}>${showArchived ? "▾" : "▸"} Archived (${spaces.filter((c) => c.status === "archived").length})</button>`}
				${showArchived && spaces.filter((c) => c.status === "archived").map((c) => html`<button class=${"item muted" + (c.id === space.id ? " active" : "")} onClick=${() => setSpaceId(c.id)}><span class="hash">◇</span><span class="cname">${c.name}</span></button>`)}
			</div>
			<div class="section"><h4>Direct messages</h4>
				${open.filter((c) => c.kind === "dm").map((c) => html`<button class=${"item" + (c.id === space.id ? " active" : "")} onClick=${() => setSpaceId(c.id)}><span class="hash">🔒</span>${c.name}</button>`)}
				${open.filter((c) => c.kind === "dm").length === 0 && html`<div class="empty" style="padding:2px 10px">Click an agent below to chat privately.</div>`}
			</div>
			<div class="section"><h4>Agents</h4>
				${me.agents.map((a) => html`<button class="item" title=${"Private chat with " + a.name + " — " + a.title} onClick=${() => me.perms.operate && openDm(a.handle)}><span class=${"dot " + status(a)}></span>${a.name}<span class="sub">${{ idle: "idle", working: "working", waiting_approval: "needs a decision" }[status(a)]}</span></button>`)}
			</div>
			</div>
			<div class="me"><${Avatar} name=${me.user.name} human=${true} /><div class="who"><b>${me.user.name}</b><span>${me.roleLabel}</span></div><a class="linkbtn" href="/auth/logout" title="Sign out">Sign out</a></div>
		</aside>
		<main class="main">
			<div class="header">
				<button class="navbtn" aria-label="Channels" onClick=${() => setNavOpen(!navOpen)}>☰</button>
				<h2>${space.kind === "dm" ? "🔒 " + space.name : space.kind === "case" ? "◆ " + space.name : "# " + space.name}</h2><span class="topic">${space.topic}</span>
				${sandboxes.find((x) => x.spaceId === space.id) && html`<span class="chip sbx" title="An isolated container where agents run commands. Removed after 30 min idle.">🧪 sandbox · idle ${Math.max(0, Math.round((Date.now() - sandboxes.find((x) => x.spaceId === space.id).lastUsed) / 60000))}m ${me.perms.operate ? html`<button class="linkbtn" onClick=${() => api(R(`/spaces/${space.id}/sandbox/stop`), { body: {} }).then(() => setSandboxes((c) => c.filter((x) => x.spaceId !== space.id))).catch((e) => flash(e.message))}>stop</button>` : ""}</span>`}
				${space.kind === "case" && me.perms.operate && html`<button class="btn small" onClick=${() => archive(space.id, space.status === "open")}>${space.status === "open" ? "Archive case" : "Reopen"}</button>`}
				${usage === null ? html`<span class="pill demo" title="No model runtime is connected; agents follow a script.">scripted agents</span>` : usage && html`<span class="pill" title=${Object.entries(usage.models).map(([k, v]) => k + ": " + v.input + " in / " + v.output + " out").join("\n")}>tokens ${Object.values(usage.models).reduce((n, v) => n + v.input + v.output, 0).toLocaleString()}</span>`}
			</div>
			${(focus?.needsYou || []).some((n) => n.spaceId === space.id) && html`<div class="banner">⚠ ${focus.needsYou.filter((n) => n.spaceId === space.id).length} decision waiting: <b>${focus.needsYou.find((n) => n.spaceId === space.id).decision.question}</b> — scroll down to the card.</div>`}
			<div class="timeline" ref=${tl} onScroll=${(e) => { const t = e.target; stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 80; }}>
				${messages.map((m) => html`<${Message} key=${m.id} m=${m} me=${me} agentIds=${agentIds} onDecide=${decide} onAction=${(a) => a.type === "message" && send(a.text)} />`)}
			</div>
			<${Composer} space=${space} agents=${space.kind === "dm" ? [] : spAgents} canPost=${me.perms.post && space.status === "open"} onSend=${send} R=${R} busy=${spAgents.some((a) => presence[a.id]?.state === "working")} />
		</main>
		<aside class="ctx">
			<${FocusPanel} focus=${focus} open=${setSpaceId} />
			<div class="ctx-scroll">
				<h3>Agents in ${space.kind === "dm" ? space.name : "#" + space.name}</h3>
				${spAgents.map((a) => html`<${AgentCard} key=${a.id} a=${a} presence=${presence} R=${R} spaceId=${space.id} canOperate=${me.perms.operate} caps=${me.caps} onStop=${stop} onFlash=${flash} />`)}
			</div>
		</aside>
		${toast && html`<div class="toast">${toast}</div>`}
	</div>`;
}

render(html`<${App} />`, document.getElementById("app"));
