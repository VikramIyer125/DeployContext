/**
 * SlackSearch — wraps Slack's Real-Time Search API (assistant.search.context).
 *
 * RTS quirk: bot-token calls require an `action_token` minted by a recent
 * `message` or `app_mention` event. The app layer captures those as events
 * arrive and exposes them via ActionTokenProvider, so searches always ride
 * on the mention that triggered the current flow.
 */
import type { WebClient } from "@slack/web-api";
import type { ConnectorResult, SlackSearch, SlackSearchResult } from "./types.js";
import { ok, err } from "./types.js";

export interface ActionTokenProvider {
  get(): string | null;
}

interface RtsMessage {
  author_name?: string;
  author_user_id?: string;
  channel_id?: string;
  channel_name?: string;
  message_ts?: string;
  content?: string;
  permalink?: string;
}

export class RtsSlackSearch implements SlackSearch {
  constructor(
    private readonly web: WebClient,
    private readonly actionTokens: ActionTokenProvider,
  ) {}

  async search(
    query: string,
    opts?: { channels?: string[]; before?: string; after?: string },
  ): Promise<ConnectorResult<SlackSearchResult[]>> {
    const actionToken = this.actionTokens.get();
    if (!actionToken) {
      return err(
        "auth",
        "no RTS action token available yet — the agent must receive a mention/message event first",
      );
    }

    let response: { ok?: boolean; error?: string; results?: { messages?: RtsMessage[] } };
    try {
      response = (await this.web.apiCall("assistant.search.context", {
        query,
        action_token: actionToken,
        channel_types: ["public_channel"],
        content_types: ["messages"],
        limit: 20,
        ...(opts?.before ? { before: opts.before } : {}),
        ...(opts?.after ? { after: opts.after } : {}),
      })) as typeof response;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes("ratelimited")) return err("rate-limited", msg);
      if (msg.includes("not_authed") || msg.includes("invalid_auth") || msg.includes("missing_scope")) {
        return err("auth", msg);
      }
      return err("unavailable", `assistant.search.context failed: ${msg}`);
    }

    const messages = response.results?.messages ?? [];
    let results: SlackSearchResult[] = messages.map((m) => ({
      text: m.content ?? "",
      permalink: m.permalink ?? "",
      author: m.author_name ?? m.author_user_id ?? "unknown",
      ts: m.message_ts ?? "",
    }));

    // RTS has no per-channel filter; scope in code when the caller asks.
    if (opts?.channels && opts.channels.length > 0) {
      const allowed = new Set(opts.channels);
      results = messages
        .filter((m) => m.channel_id && allowed.has(m.channel_id))
        .map((m) => ({
          text: m.content ?? "",
          permalink: m.permalink ?? "",
          author: m.author_name ?? m.author_user_id ?? "unknown",
          ts: m.message_ts ?? "",
        }));
    }

    return ok(results);
  }
}

/** Simple latest-wins token store; the app layer updates it on every event. */
export class LatestActionTokenStore implements ActionTokenProvider {
  private token: string | null = null;

  set(token: string | undefined | null): void {
    if (token) this.token = token;
  }

  get(): string | null {
    return this.token;
  }
}
