package dev.notch.companion.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import dev.notch.companion.data.SessionStatus

// Lifted from the desktop renderer so the phone reads as the same product.
private val Ink = Color(0xFFF4EFE7)
private val Bark = Color(0xFF171513)
private val Clay = Color(0xFFD97757)
private val Surface = Color(0xFF211E1B)
private val Muted = Color(0xFF8C837A)

private val Dark = darkColorScheme(
  primary = Clay,
  onPrimary = Bark,
  background = Bark,
  onBackground = Ink,
  surface = Surface,
  onSurface = Ink,
  surfaceVariant = Surface,
  onSurfaceVariant = Muted,
  outline = Color(0xFF3A342E),
  error = Color(0xFFE0685A)
)

private val Light = lightColorScheme(
  primary = Color(0xFFB4573A),
  onPrimary = Color.White,
  background = Color(0xFFF7F3ED),
  onBackground = Bark,
  surface = Color.White,
  onSurface = Bark,
  surfaceVariant = Color(0xFFEDE7DE),
  onSurfaceVariant = Color(0xFF6B635A),
  outline = Color(0xFFD8D0C4),
  error = Color(0xFFB3261E)
)

@Composable
fun NotchTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = if (isSystemInDarkTheme()) Dark else Light,
    content = content
  )
}

/** Mirrors the desktop pill colours, so a green dot means the same thing here. */
@Composable
fun statusColor(status: SessionStatus): Color = when (status) {
  SessionStatus.NEEDS_INPUT -> Clay
  SessionStatus.WORKING -> Color(0xFF6FA96B)
  SessionStatus.REVIEWING -> Color(0xFFC9A227)
  SessionStatus.IDLE -> Muted
  SessionStatus.UNKNOWN -> Muted
}
