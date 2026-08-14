package dev.notch.companion

import dev.notch.companion.data.isPrivateBridgeHost
import dev.notch.companion.data.remotePairingIsAlreadyGone
import dev.notch.companion.data.Connection
import dev.notch.companion.data.SessionStatus
import dev.notch.companion.data.SessionSummary
import dev.notch.companion.data.Snapshot
import dev.notch.companion.service.waitingSessions
import dev.notch.companion.service.shouldStartWatcherAfterBoot
import dev.notch.companion.ui.normalizeAddress
import dev.notch.companion.ui.parsePairingUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionParsingTest {
  @Test
  fun pairingUrlSeparatesTheSecretFragment() {
    val parsed = parsePairingUrl("http://192.168.1.20:47822/#pair=123456")
    assertEquals("http://192.168.1.20:47822", parsed?.baseUrl)
    assertEquals("123456", parsed?.code)
    assertNull(parsePairingUrl("not a URL"))
  }

  @Test
  fun manualAddressesNormalizeWithoutChangingTheHost() {
    assertEquals("http://192.168.1.20:47822", normalizeAddress(" 192.168.1.20:47822/ "))
    assertEquals("https://notch.example", normalizeAddress("https://notch.example/"))
  }

  @Test
  fun cleartextHostPolicyAllowsOnlyLocalPrivateRanges() {
    assertTrue(isPrivateBridgeHost("192.168.1.20"))
    assertTrue(isPrivateBridgeHost("100.100.10.20"))
    assertTrue(isPrivateBridgeHost("localhost"))
    assertFalse(isPrivateBridgeHost("203.0.113.10"))
    assertFalse(isPrivateBridgeHost("example.com"))
    assertFalse(isPrivateBridgeHost("192.168.1.999"))
  }

  @Test
  fun onlyAnAlreadyRevokedCredentialCanBeForgottenAfterDeleteFailure() {
    assertTrue(remotePairingIsAlreadyGone(401))
    assertFalse(remotePairingIsAlreadyGone(403))
    assertFalse(remotePairingIsAlreadyGone(500))
  }

  @Test
  fun staleSnapshotsCannotProduceOfflineAlerts() {
    val waiting = SessionSummary(
      key = "session-1",
      agent = "claude",
      name = "Audit",
      project = "notch",
      path = "C:/notch",
      status = SessionStatus.NEEDS_INPUT,
      detail = "Waiting",
      updatedAt = 1,
      canMessage = true
    )
    val snapshot = Snapshot("PC", listOf(waiting), emptyList())
    assertEquals(listOf(waiting), waitingSessions(snapshot, Connection.ONLINE))
    assertTrue(waitingSessions(snapshot, Connection.CONNECTING).isEmpty())
    assertTrue(waitingSessions(snapshot, Connection.OFFLINE).isEmpty())
  }

  @Test
  fun bootRestoresOnlyAnAuthorizedConfiguredWatcher() {
    assertTrue(shouldStartWatcherAfterBoot(true, true, true, true))
    assertFalse(shouldStartWatcherAfterBoot(false, true, true, true))
    assertFalse(shouldStartWatcherAfterBoot(true, false, true, true))
    assertFalse(shouldStartWatcherAfterBoot(true, true, false, true))
    assertFalse(shouldStartWatcherAfterBoot(true, true, true, false))
  }
}
