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
