package net.porthole.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * The web panel's palette, carried across so the two do not feel like different products.
 *
 * A ship's bridge at night: instruments dimmed to protect night vision, so the ground is
 * a deep blue-green rather than black, and the accent is brass, the material of the rim
 * you are looking through. The status colours are the vessel's own running lights, which
 * is why red and green mean what they mean here rather than being an arbitrary pick.
 */
object Hull {
    val hull = Color(0xFF0D1418)
    val deck = Color(0xFF131F24)
    val deckHigh = Color(0xFF18272D)
    val rim = Color(0xFF23383F)
    val rimLit = Color(0xFF2F4A53)

    val brass = Color(0xFFC9A227)
    val brassDim = Color(0xFF8A7326)

    val foam = Color(0xFFD9E5E8)
    val fathom = Color(0xFF7E969D)
    val fathomDim = Color(0xFF5B7178)

    val port = Color(0xFFE8563F)
    val starboard = Color(0xFF4FB286)
}

private val scheme = darkColorScheme(
    primary = Hull.brass,
    onPrimary = Color(0xFF1A1405),
    secondary = Hull.rimLit,
    background = Hull.hull,
    onBackground = Hull.foam,
    surface = Hull.deck,
    onSurface = Hull.foam,
    surfaceVariant = Hull.deckHigh,
    onSurfaceVariant = Hull.fathom,
    error = Hull.port,
    outline = Hull.rim,
)

@Composable
fun PortholeTheme(content: @Composable () -> Unit) {
    // Always the night palette. A terminal on a white background is nobody's friend, and
    // this is a thing you reach for in the dark.
    @Suppress("UNUSED_EXPRESSION")
    isSystemInDarkTheme()
    MaterialTheme(colorScheme = scheme, content = content)
}
