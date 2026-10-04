import nacl from "tweetnacl";

const GITHUB_OWNER = "abhinav-sharma-alt";
const GITHUB_REPO = "palworld-server";   // <- change to your new repo name
const WORKFLOW_FILE = "start-server.yml";
const COMMAND_PATH = "console/command.txt";
const STOP_PATH = "console/stop.txt";
const ACCESS_PATH = "console/authorized_users.json";

const json = (content, flags) =>
  new Response(JSON.stringify({ type: 4, data: { content, ...(flags ? { flags } : {}) } }), {
    headers: { "Content-Type": "application/json" },
  });

const ghHeaders = (env) => ({
  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "palworld-discord-bot",
});
const repoApi = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

function hexToUint8Array(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

async function verifyDiscordRequest(request, publicKey) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();
  if (!signature || !timestamp) return { valid: false, body };
  const valid = nacl.sign.detached.verify(
    new TextEncoder().encode(timestamp + body),
    hexToUint8Array(signature),
    hexToUint8Array(publicKey)
  );
  return { valid, body };
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));

const WORLD_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

async function getRepoFile(env, path) {
  const res = await fetch(`${repoApi}/contents/${path}`, { headers: ghHeaders(env) });
  if (!res.ok) return null;
  const data = await res.json();
  if (Array.isArray(data)) return data;
  try { return unb64(data.content); } catch { return null; }
}

// "ExpRate=2,DeathPenalty=None,bIsPvP=false" -> { ExpRate: 2, DeathPenalty: "None", bIsPvP: false }
// An empty value ("ExpRate=") maps to null, meaning "remove this override".
function parseSettings(str) {
  const out = {};
  for (const part of (str || "").split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error(`Invalid setting name \`${k}\` (letters, digits, _ only).`);
    if (/["()]/.test(v)) throw new Error(`Setting \`${k}\` can't contain quotes or parentheses.`);
    if (v === "") { out[k] = null; continue; }
    if (/^(true|false)$/i.test(v)) v = v.toLowerCase() === "true";
    else if (!isNaN(Number(v))) v = Number(v);
    out[k] = v;
  }
  return out;
}

function describeMeta(meta) {
  const settings = Object.entries(meta.settings || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return [
    `• server name: \`${meta.server_name || "Palworld Server"}\``,
    `• max players: \`${meta.max_players ?? 16}\``,
    `• port: \`${meta.server_port ?? 8211}\``,
    `• tunnel: \`${meta.tunnel_address || "⚠️ not set"}\``,
    `• settings: ${settings}`,
  ].join("\n");
}

async function triggerStart(env, world) {
  const res = await fetch(`${repoApi}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    headers: ghHeaders(env),
    body: JSON.stringify({ ref: "main", inputs: { world: world || "default" } }),
  });
  return res.ok;
}

async function isRunning(env) {
  const res = await fetch(
    `${repoApi}/actions/workflows/${WORKFLOW_FILE}/runs?status=in_progress&per_page=1`,
    { headers: ghHeaders(env) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data.workflow_runs?.length || 0) > 0;
}

// Create or overwrite a file in the repo via the contents API.
async function putFile(env, path, text, message) {
  const url = `${repoApi}/contents/${path}`;
  let sha;
  const get = await fetch(url, { headers: ghHeaders(env) });
  if (get.ok) sha = (await get.json()).sha;
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: b64(text), ...(sha ? { sha } : {}) }),
  });
  return put.ok;
}

const queueStop = (env) => putFile(env, STOP_PATH, "stop\n", "console: request graceful stop");
const queueCommand = (env, command) =>
  putFile(env, COMMAND_PATH, `${crypto.randomUUID()}\n${command}\n`, `console: queue "${command}"`);

async function getAuthorizedUsers(env) {
  const res = await fetch(`${repoApi}/contents/${ACCESS_PATH}`, { headers: ghHeaders(env) });
  if (!res.ok) return { users: [], sha: undefined };
  const data = await res.json();
  try {
    const parsed = JSON.parse(unb64(data.content));
    return { users: Array.isArray(parsed.users) ? parsed.users : [], sha: data.sha };
  } catch {
    return { users: [], sha: data.sha };
  }
}

const saveAuthorizedUsers = (env, users) =>
  putFile(env, ACCESS_PATH, JSON.stringify({ users }, null, 2) + "\n", "access: update authorized users");

async function isAuthorized(env, userId) {
  if (userId === env.AUTHORIZED_USER_ID) return true;
  const { users } = await getAuthorizedUsers(env);
  return users.some((u) => u.id === userId);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Expected POST", { status: 405 });

    const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response("Bad request signature", { status: 401 });

    const interaction = JSON.parse(body);
    if (interaction.type === 1) {
      return new Response(JSON.stringify({ type: 1 }), { headers: { "Content-Type": "application/json" } });
    }
    if (interaction.type !== 2) return new Response("Unknown interaction", { status: 400 });

    const name = interaction.data.name;
    const userId = interaction.member?.user?.id || interaction.user?.id;
    const sub = interaction.data.options?.[0];
    const getOpt = (n) => (name === "start" || name === "console" ? interaction.data.options : sub?.options)?.find((o) => o.name === n)?.value;

    if (name === "start") {
      const world = getOpt("world") || "default";
      const rawMeta = await getRepoFile(env, `worlds/${world}/meta.json`);
      if (rawMeta === null) {
        return json(`❌ World **${world}** doesn't exist yet. Create it with \`/world create name: ${world} tunnel_address: <your playit address>\`.`);
      }
      try {
        if (!JSON.parse(rawMeta).tunnel_address) {
          return json(`❌ World **${world}** has no tunnel address. Set one: \`/world configure name: ${world} tunnel_address: <your playit address>\`.`);
        }
      } catch {
        return json(`❌ \`worlds/${world}/meta.json\` is not valid JSON.`);
      }
      const ok = await triggerStart(env, world);
      return json(
        ok
          ? `🟢 Starting Palworld world **${world}**... needs ~5-8 min (game download + boot). The connect address will be posted here.`
          : "❌ Failed to trigger the start workflow."
      );
    }

    if (name === "stop") {
      if ((await isRunning(env)) === false) return json("⚪ No server is currently running.");
      const ok = await queueStop(env);
      return json(ok ? "🟡 Stop requested — world will save and shut down shortly." : "❌ Failed to send stop signal.");
    }

    if (name === "console") {
      if (!(await isAuthorized(env, userId))) {
        return json("⛔ You're not authorized to use console access. Ask the server owner to run `/access add`.", 64);
      }
      let command = getOpt("command");
      if (!command) return json("No command provided.");
      command = command.replace(/^\/?(\S+)/, (_, w) => w.toLowerCase());
      const ok = await queueCommand(env, command);
      return json(ok ? `⏳ Queued: \`${command}\` (runs within ~5s if the server is up)` : "❌ Failed to queue command.");
    }

    if (name === "world") {
      const subName = sub?.name;

      if (subName === "list") {
        const dir = await getRepoFile(env, "worlds");
        const names = Array.isArray(dir) ? dir.filter((e) => e.type === "dir").map((e) => e.name) : [];
        if (names.length === 0) return json("No worlds yet. Create one with `/world create`.", 64);
        const lines = await Promise.all(names.map(async (n) => {
          const raw = await getRepoFile(env, `worlds/${n}/meta.json`);
          if (!raw) return `• **${n}** — no meta.json`;
          try {
            const m = JSON.parse(raw);
            return `• **${n}** — \`${m.server_name || "Palworld Server"}\`, port \`${m.server_port ?? 8211}\`, tunnel \`${m.tunnel_address || "⚠️ not set"}\``;
          } catch { return `• **${n}** — meta.json unreadable`; }
        }));
        return json(`**🌍 Worlds:**\n${lines.join("\n")}`, 64);
      }

      if (subName !== "create" && subName !== "configure") return json("❌ Unknown /world subcommand.");
      if (!(await isAuthorized(env, userId))) {
        return json("⛔ You're not authorized to manage worlds. Ask the server owner to run `/access add`.", 64);
      }

      const wname = (getOpt("name") || "").toLowerCase();
      if (!WORLD_NAME_RE.test(wname)) {
        return json("❌ `name` must be lowercase letters/digits/`-`/`_` (max 31 chars), e.g. `default` or `friends`.", 64);
      }
      const path = `worlds/${wname}/meta.json`;
      const existing = await getRepoFile(env, path);
      if (subName === "create" && existing !== null) {
        return json(`❌ World **${wname}** already exists. Use \`/world configure name: ${wname} ...\` to change it.`, 64);
      }
      if (subName === "configure" && existing === null) {
        return json(`❌ World **${wname}** doesn't exist. Create it with \`/world create name: ${wname}\`.`, 64);
      }

      let meta = {};
      if (existing !== null) {
        try { meta = JSON.parse(existing); } catch { return json(`❌ \`${path}\` is not valid JSON.`, 64); }
      }

      const serverName = getOpt("server_name");
      const maxPlayers = getOpt("max_players");
      const serverPort = getOpt("server_port");
      const tunnel = getOpt("tunnel_address");
      if (serverName !== undefined) meta.server_name = serverName;
      if (maxPlayers !== undefined) meta.max_players = maxPlayers;
      if (serverPort !== undefined) meta.server_port = serverPort;
      if (tunnel !== undefined) meta.tunnel_address = tunnel.trim();

      const settingsStr = getOpt("settings");
      if (settingsStr !== undefined) {
        let parsed;
        try { parsed = parseSettings(settingsStr); } catch (e) { return json(`❌ ${e.message}`, 64); }
        meta.settings = { ...(meta.settings || {}) };
        for (const [k, v] of Object.entries(parsed)) {
          if (v === null) delete meta.settings[k]; else meta.settings[k] = v;
        }
      }
      if (subName === "create") {
        meta.server_name ??= "Palworld Server";
        meta.max_players ??= 16;
        meta.server_port ??= 8211;
      }

      const ok = await putFile(env, path, JSON.stringify(meta, null, 2) + "\n", `world: ${subName} ${wname}`);
      if (!ok) return json("❌ Failed to write meta.json — check the GitHub token/repo settings.");
      const warn = meta.tunnel_address ? "" : `\n⚠️ No tunnel address yet — set one with \`/world configure name: ${wname} tunnel_address: <your playit address>\` before \`/start\`.`;
      return json(
        `${subName === "create" ? "🟢 Created" : "🟡 Updated"} world **${wname}**:\n${describeMeta(meta)}\nStart it with \`/start world: ${wname}\`. Changes apply on the next start.${warn}`
      );
    }

    if (name === "access") {
      const subName = sub?.name;
      if (subName === "list") {
        if (!(await isAuthorized(env, userId))) return json("⛔ You're not authorized.", 64);
        const { users } = await getAuthorizedUsers(env);
        const lines = [`• <@${env.AUTHORIZED_USER_ID}> (owner)`, ...users.map((u) => `• <@${u.id}>${u.name ? ` (${u.name})` : ""}`)];
        return json(`**🔑 Users with console access:**\n${lines.join("\n")}`, 64);
      }
      if (userId !== env.AUTHORIZED_USER_ID) return json("⛔ Only the server owner can grant or revoke access.", 64);
      const target = getOpt("user");
      if (!target) return json("❌ `user` is required.", 64);
      const resolved = interaction.data.resolved?.users?.[target];
      const targetName = resolved?.username || resolved?.global_name;
      const { users } = await getAuthorizedUsers(env);

      if (subName === "add") {
        if (target === env.AUTHORIZED_USER_ID) return json("That user is already the owner.", 64);
        if (users.some((u) => u.id === target)) return json(`<@${target}> already has access.`, 64);
        users.push({ id: target, name: targetName });
        return json((await saveAuthorizedUsers(env, users)) ? `✅ <@${target}> can now use \`/console\`.` : "❌ Failed to update the access list.");
      }
      if (subName === "remove") {
        const filtered = users.filter((u) => u.id !== target);
        if (filtered.length === users.length) return json(`<@${target}> didn't have access.`, 64);
        return json((await saveAuthorizedUsers(env, filtered)) ? `🗑️ Removed <@${target}>'s access.` : "❌ Failed to update the access list.");
      }
    }

    return json("❌ Unknown command.");
  },
};