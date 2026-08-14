package dev.notch.companion.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * Returns a function that opens the barcode scanner and hands back its text.
 *
 * ScanContract handles the camera permission prompt itself, so there is no
 * separate permission dance here — declining simply produces no result.
 */
@Composable
fun rememberQrScanner(onResult: (String) -> Unit): () -> Unit {
  val launcher = rememberLauncherForActivityResult(ScanContract()) { result ->
    result.contents?.let(onResult)
  }
  val options = remember {
    ScanOptions()
      .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
      .setPrompt("Point at the QR code in Notch's Settings tab")
      .setBeepEnabled(false)
      .setOrientationLocked(false)
  }
  return { launcher.launch(options) }
}
