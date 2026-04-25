import { db } from "../lib/db";

type RecordMessageInput = {
  messageId: string;
  guildId: string;
  channelId: string;
  userId: string;
  content: string;
  createdAt: string;
};

function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu);
  return matches?.length ?? 0;
}
function countLines(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

export class ActivityService {
  public static recordMessage(input: RecordMessageInput) {
    const content = input.content ?? "";
    const wordCount = countWords(content);
    const lineCount = countLines(content);
    const charCount = content.length;

    const upsertActivity = db.prepare(`
      INSERT INTO user_activity (
        guild_id,
        user_id,
        message_count,
        line_count,
        word_count,
        char_count,
        last_message_at
      )
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        message_count = message_count + 1,
        line_count = line_count + excluded.line_count,
        word_count = word_count + excluded.word_count,
        char_count = char_count + excluded.char_count,
        last_message_at = excluded.last_message_at
    `);

    const insertLog = db.prepare(`
      INSERT OR IGNORE INTO message_logs (
        message_id,
        guild_id,
        channel_id,
        user_id,
        content,
        line_count,
        word_count,
        char_count,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
      upsertActivity.run(
        input.guildId,
        input.userId,
        lineCount,
        wordCount,
        charCount,
        input.createdAt,
      );

      if (process.env.SAVE_RAW_MESSAGES === "true") {
        insertLog.run(
          input.messageId,
          input.guildId,
          input.channelId,
          input.userId,
          content,
          lineCount,
          wordCount,
          charCount,
          input.createdAt,
        );
      }
    });

    transaction();
  }

  public static getUserStats(guildId: string, userId: string) {
    const stmt = db.prepare(`
      SELECT
        guild_id,
        user_id,
        message_count,
        line_count,
        word_count,
        char_count,
        last_message_at
      FROM user_activity
      WHERE guild_id = ? AND user_id = ?
    `);

    return stmt.get(guildId, userId) as
      | {
          guild_id: string;
          user_id: string;
          message_count: number;
          line_count: number;
          word_count: number;
          char_count: number;
          last_message_at: string | null;
        }
      | undefined;
  }

  public static getTopUsers(guildId: string, limit = 10) {
    const stmt = db.prepare(`
      SELECT
        guild_id,
        user_id,
        message_count,
        line_count,
        word_count,
        char_count,
        last_message_at
      FROM user_activity
      WHERE guild_id = ?
      ORDER BY word_count DESC, message_count DESC
      LIMIT ?
    `);

    return stmt.all(guildId, limit) as Array<{
      guild_id: string;
      user_id: string;
      message_count: number;
      line_count: number;
      word_count: number;
      char_count: number;
      last_message_at: string | null;
    }>;
  }
  public static getGuildTotals(guildId: string) {
    const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(message_count), 0) AS message_count,
      COALESCE(SUM(line_count), 0) AS line_count,
      COALESCE(SUM(word_count), 0) AS word_count,
      COALESCE(SUM(char_count), 0) AS char_count
    FROM user_activity
    WHERE guild_id = ?
  `);

    return stmt.get(guildId) as {
      message_count: number;
      line_count: number;
      word_count: number;
      char_count: number;
    };
  }
}
