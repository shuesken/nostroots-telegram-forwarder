import * as nostrify from "@nostrify/nostrify";
import * as nip19 from "nostr-tools/nip19";
import { decode, encode } from "pluscodes";
import {
  LABEL_NAMESPACE_TAG,
  OPEN_LOCATION_CODE_NAMESPACE_TAG,
  PLUS_CODE_TAG_KEY,
} from "./constants";

const relayUrls = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nostr.manasiwibi.com",
  "wss://nos.lol",
];

const TOKEN = "YOUR_TOKEN_HERE";

export interface Env {
  KEYS: KVNamespace;
}

/**
 * Return url to telegram api, optionally with parameters added
 */
function apiUrl(
  methodName: string,
  params: Record<string, string> | undefined = undefined
) {
  let query = "";
  if (params) {
    query = "?" + new URLSearchParams(params).toString();
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`;
}

/**
 * Send plain text message
 * https://core.telegram.org/bots/api#sendmessage
 */
async function sendPlainText(chatId, text) {
  return (
    await fetch(
      apiUrl("sendMessage", {
        chat_id: chatId,
        text,
      })
    )
  ).json();
}

async function signAndPublish(unsignedEvent: any, chatId: string, env: Env) {
  const nsec = await env.KEYS.get(chatId);
  if (nsec) {
    let { data: secretKey } = nip19.decode(nsec);
    const signer = new nostrify.NSecSigner(secretKey);

    const event = await signer.signEvent(unsignedEvent);
    await sendPlainText(chatId, JSON.stringify(event, null, 2));

    await Promise.allSettled(
      relayUrls.map(async (relayUrl) => {
        const relay = new nostrify.NRelay1(relayUrl);
        await relay.event(event);
        await sendPlainText(chatId, `Published to ${relayUrl}`);
      })
    );
  } else {
    await sendPlainText(
      chatId,
      "please set your secret key first with /set_secret_key <yourkey:nsec>"
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      const body = (await request.json()) as any;

      console.log(JSON.stringify(body));

      const text: string = body?.message?.text;
      const chatId = body?.message?.chat?.id || body?.edited_message?.chat?.id;
      const location =
        body?.message?.location || body?.edited_message?.location;
      const livePeriod =
        body?.message?.location?.live_period ||
        body?.edited_message?.location?.live_period;

      if (text === "/help" || text === "/start") {
        await sendPlainText(
          chatId,
          "This bot can forward your location-based messages to Nostroots. First, you need to set your secret key with /set_secret_key <secretkey:nsec>. Then you can send location events to this bot; they will be posted with your key and the message 'some party here' on the Nostroots map, expiring after one hour. If you share your live location, it will be continuously posted to the map, with an expiry of 1 minute."
        );
      } else if (
        typeof text === "string" &&
        text.startsWith("/set_secret_key")
      ) {
        const secretKey = text.split(" ")[1];

        if (secretKey && secretKey.startsWith("nsec1")) {
          await sendPlainText(chatId, "got valid secret key");
          await env.KEYS.put(chatId, secretKey);
        } else {
          await sendPlainText(chatId, "that is not a valid secret key");
        }
      } else if (location && !livePeriod) {
        const plusCode = encode(location, 10);
        const expiresAt = Math.floor(Date.now() / 1000 + 60 * 60);
        const unsignedEvent = {
          kind: 397,
          content: "some party here",
          tags: [
            [LABEL_NAMESPACE_TAG, OPEN_LOCATION_CODE_NAMESPACE_TAG],
            [PLUS_CODE_TAG_KEY, plusCode, OPEN_LOCATION_CODE_NAMESPACE_TAG],
            ["expiration", `${expiresAt}`],
          ],
          created_at: Math.floor(Date.now() / 1000),
        };
        await signAndPublish(unsignedEvent, chatId, env);
      } else if (location && livePeriod) {
        const plusCode = encode(location, 10);
        const expiresAt = Math.floor(Date.now() / 1000 + 1 * 60);
        const unsignedEvent = {
          kind: 397,
          content: "live location",
          tags: [
            [LABEL_NAMESPACE_TAG, OPEN_LOCATION_CODE_NAMESPACE_TAG],
            [PLUS_CODE_TAG_KEY, plusCode, OPEN_LOCATION_CODE_NAMESPACE_TAG],
            ["expiration", `${expiresAt}`],
          ],
          created_at: Math.floor(Date.now() / 1000),
        };
        await signAndPublish(unsignedEvent, chatId, env);
      } else {
        await sendPlainText(
          chatId,
          "got message but did not do anything with it"
        );
      }
      return new Response();
    } catch (e) {
      console.error(e);
      return new Response();
    }
  },
};
