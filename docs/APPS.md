# Stellan for your apps

Ask Stellan to build "a game where the shopkeeper talks back" and the game can use **Stellan itself** as its AI, on the same computer, with no internet and no AI subscription.

## Turn it on

Settings → Models → **Stellan for your apps** → tick **Let apps on this computer use Stellan**. It's off until you turn it on. Settings then shows:

- **Address:** `http://127.0.0.1:7341/v1/chat/completions`
- **App key:** a long code starting `stellan-app-`. **Copy key** copies it; **Make a new key** replaces it (apps using the old key stop working until updated).

While it's on, Stellan knows about it. Ask for an app that needs AI and Stellan wires it to this address, puts the key in one config file, and tells you where.

## What an app sends

It's the same format as OpenAI's chat API, so most libraries and examples work by changing the address:

```js
const reply = await fetch("http://127.0.0.1:7341/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer stellan-app-…", "X-Stellan-App": "Dungeon Game" },
  body: JSON.stringify({ messages: [
    { role: "system", content: "You are Bram, a grumpy shopkeeper in a fantasy village. Answer in one or two sentences." },
    { role: "user", content: "Do you sell swords?" }
  ], max_tokens: 120 })
});
const text = (await reply.json()).choices[0].message.content;
```

- `X-Stellan-App` is the name shown to you when the app first asks.
- Replies are capped at 1,024 tokens. Streaming isn't supported yet.
- `GET /v1/models` lists one model, `stellan`.

## What you'll see

The first time an app asks, Stick AI shows **Let "Dungeon Game" use Stellan?** with **Allow** and **Don't allow**. Your answer lasts until you start a new conversation. Apps get **text replies only**: they can't read your files, use tools or run commands, and they never see your conversation.

## Your work comes first

Stellan does one thing at a time. If you're working with Stellan, or it's resting or not started, an app gets a polite "try again shortly" (HTTP 503 with `Retry-After: 5`) instead of interrupting you. If an app is mid-reply when you send a message, your message waits a few seconds for it. Your conversation's memory is saved before each app reply and restored afterwards, so app use doesn't make your next reply slower.

## Safety

- It listens only on `127.0.0.1`, never on your network.
- Web pages from the internet can't use it: browsers are only allowed in from pages served by this computer (`http://localhost`, `http://127.0.0.1`) or files you open directly, and requests must name `127.0.0.1` or `localhost` (this blocks "DNS rebinding" tricks).
- Every request needs the app key, and every new app needs your **Allow**.
- Turning it off closes the door at once.

## When something's wrong

| The app gets | Means | Do this |
| --- | --- | --- |
| 401 | Missing or old key | Copy the key from Settings into the app |
| 403 "didn't allow" | You pressed Don't allow | Start a new conversation in Stick AI, then try the app again |
| 403 "only apps on this computer" | The page came from the internet | Run the app locally (Stellan can set that up) |
| 503 | Stellan is busy, resting or not started | Wait, or open Stick AI and send a message; the app should retry |
| Can't connect | It's turned off, or port 7341 is taken | Turn it on in Settings; the message there names the problem |

## Planned

Streaming replies, a small JavaScript/Python helper, a ready-made "talking characters" example game on the stick, and later letting a finished app ship with its own copy of Lite.
