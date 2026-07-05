/**
 * ThreadReporter — short in-thread progress narration while the loop runs.
 * Tests inject NullReporter.
 */
import type { WebClient } from "@slack/web-api";
import type { Investigation } from "../domain/types.js";
import { log } from "../log.js";

export interface ThreadReporter {
  progress(inv: Investigation, line: string): Promise<void>;
}

export class NullReporter implements ThreadReporter {
  lines: string[] = [];

  async progress(_inv: Investigation, line: string): Promise<void> {
    this.lines.push(line);
  }
}

/** Logs progress to stdout — used by headless exit-test runs. */
export class ConsoleReporter implements ThreadReporter {
  async progress(inv: Investigation, line: string): Promise<void> {
    log.info(`[inv ${inv.id}] ${line}`);
  }
}

export class SlackThreadReporter implements ThreadReporter {
  constructor(private readonly client: WebClient) {}

  async progress(inv: Investigation, line: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: inv.trigger.channel,
        thread_ts: inv.trigger.threadTs,
        text: line,
      });
    } catch (e) {
      log.warn("reporter post failed", { error: (e as Error).message });
    }
  }
}
