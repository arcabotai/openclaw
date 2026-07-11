package ai.openclaw.app.chat

import android.database.sqlite.SQLiteDatabase
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * Proves the shipped legacy schemas upgrade in place. Legacy databases are built with the exact
 * DDL Room generated for those versions; opening them through [ChatCacheDatabase.open] runs the
 * real migrations, and Room then validates the migrated schema against the current entities, so
 * any drift between these fixtures, the migrations, and the entities fails the test.
 */
@RunWith(RobolectricTestRunner::class)
class ChatCacheDatabaseMigrationTest {
  private val context = RuntimeEnvironment.getApplication()
  private var database: ChatCacheDatabase? = null

  @After
  fun tearDown() {
    database?.close()
    context.deleteDatabase(CHAT_TRANSCRIPT_CACHE_DB_NAME)
  }

  private fun open(): ChatCacheDatabase = ChatCacheDatabase.open(context).also { database = it }

  private fun createLegacyDatabase(
    version: Int,
    block: (SQLiteDatabase) -> Unit,
  ) {
    val file = context.getDatabasePath(CHAT_TRANSCRIPT_CACHE_DB_NAME)
    file.parentFile?.mkdirs()
    val db = SQLiteDatabase.openOrCreateDatabase(file, null)
    try {
      block(db)
      db.version = version
    } finally {
      db.close()
    }
  }

  private fun SQLiteDatabase.createLegacyCacheTables() {
    execSQL(
      "CREATE TABLE IF NOT EXISTS `cached_sessions` (`gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, " +
        "`displayName` TEXT, `updatedAtMs` INTEGER, `rowOrder` INTEGER NOT NULL, PRIMARY KEY(`gatewayId`, `sessionKey`))",
    )
    execSQL(
      "CREATE TABLE IF NOT EXISTS `cached_messages` (`gatewayId` TEXT NOT NULL, `sessionKey` TEXT NOT NULL, " +
        "`rowOrder` INTEGER NOT NULL, `role` TEXT NOT NULL, `textPartsJson` TEXT NOT NULL, `timestampMs` INTEGER, " +
        "`idempotencyKey` TEXT, PRIMARY KEY(`gatewayId`, `sessionKey`, `rowOrder`))",
    )
  }

  // Shipped v2 outbox table: no gatedEpoch column, no attachment tables.
  private fun SQLiteDatabase.createV2OutboxTable() {
    execSQL(
      "CREATE TABLE IF NOT EXISTS `outbox_commands` (`id` TEXT NOT NULL, `gatewayId` TEXT NOT NULL, " +
        "`sessionKey` TEXT NOT NULL, `text` TEXT NOT NULL, `thinkingLevel` TEXT NOT NULL, " +
        "`createdAtMs` INTEGER NOT NULL, `status` TEXT NOT NULL, `retryCount` INTEGER NOT NULL, " +
        "`lastError` TEXT, PRIMARY KEY(`id`))",
    )
  }

  @Test
  fun v2UpgradePreservesQueuedTextRows() =
    runTest {
      createLegacyDatabase(version = 2) { db ->
        db.createLegacyCacheTables()
        db.createV2OutboxTable()
        db.execSQL(
          "INSERT INTO outbox_commands (id, gatewayId, sessionKey, text, thinkingLevel, createdAtMs, status, retryCount, lastError) " +
            "VALUES ('row-1', 'gateway-a', 'main', 'queued before upgrade', 'high', 10, 'queued', 0, NULL)",
        )
        db.execSQL(
          "INSERT INTO outbox_commands (id, gatewayId, sessionKey, text, thinkingLevel, createdAtMs, status, retryCount, lastError) " +
            "VALUES ('row-2', 'gateway-a', 'agent:work:main', 'failed before upgrade', 'off', 20, 'failed', 3, 'boom')",
        )
      }

      val store = RoomChatCommandOutbox(open())
      val rows = store.load("gateway-a")

      assertEquals(listOf("row-1", "row-2"), rows.map { it.id })
      val queued = rows.first()
      assertEquals("queued before upgrade", queued.text)
      assertEquals("high", queued.thinkingLevel)
      assertEquals(ChatOutboxStatus.Queued, queued.status)
      assertEquals(10L, queued.createdAtMs)
      assertNull(queued.gatedEpoch)
      assertTrue(queued.attachments.isEmpty())
      val failed = rows.last()
      assertEquals(ChatOutboxStatus.Failed, failed.status)
      assertEquals("boom", failed.lastError)
    }

  @Test
  fun v2UpgradeSupportsAttachmentsAndSurvivesReopen() =
    runTest {
      createLegacyDatabase(version = 2) { db ->
        db.createLegacyCacheTables()
        db.createV2OutboxTable()
      }

      val bytes = ByteArray(OUTBOX_ATTACHMENT_CHUNK_BYTES + 77) { (it % 127).toByte() }
      val queued =
        RoomChatCommandOutbox(open()).enqueue(
          gatewayId = "gateway-a",
          sessionKey = "main",
          text = "post-upgrade media",
          thinkingLevel = "off",
          nowMs = 5,
          attachments =
            listOf(
              OutboxAttachmentPayload(type = "image", mimeType = "image/jpeg", fileName = "a.jpg", durationMs = null, bytes = bytes),
            ),
        ) as ChatOutboxEnqueueResult.Queued
      database?.close()
      database = null

      // Process-restart analog: a fresh open must recover the exact bytes.
      val reopened = RoomChatCommandOutbox(open())
      val loaded = reopened.loadAttachments(queued.item.id)
      assertEquals(1, loaded.size)
      assertTrue(bytes.contentEquals(loaded.single().bytes))
    }

  @Test
  fun v1UpgradeRebuildsDisposableCacheAndCreatesEmptyOutbox() =
    runTest {
      createLegacyDatabase(version = 1) { db ->
        db.createLegacyCacheTables()
        db.execSQL(
          "INSERT INTO cached_sessions (gatewayId, sessionKey, displayName, updatedAtMs, rowOrder) " +
            "VALUES ('gateway-a', 'main', 'Main', 1, 0)",
        )
      }

      val db = open()
      // The disposable cache may be rebuilt empty; the outbox tables must exist and work.
      assertTrue(RoomChatTranscriptCache(db).loadSessions("gateway-a").isEmpty())
      val store = RoomChatCommandOutbox(db)
      assertTrue(store.load("gateway-a").isEmpty())
      val queued =
        store.enqueue(gatewayId = "gateway-a", sessionKey = "main", text = "fresh", thinkingLevel = "off", nowMs = 1)
      assertTrue(queued is ChatOutboxEnqueueResult.Queued)
    }
}
