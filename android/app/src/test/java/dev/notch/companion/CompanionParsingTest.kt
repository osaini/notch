package dev.notch.companion

import dev.notch.companion.data.isPrivateBridgeHost
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
}
