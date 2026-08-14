package net.porthole.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.porthole.net.claimPairing
import net.porthole.store.Panel
import net.porthole.store.parsePairingUri
import java.util.concurrent.Executors

/**
 * Pairing by camera.
 *
 * Uses zxing rather than ML Kit so there is no Play Services dependency: this has to
 * work on a bare emulator image and on a phone without Google services, which is exactly
 * the sort of phone somebody self-hosting a panel is likely to own.
 */
@Composable
fun ScanScreen(autoPairUri: String? = null, onCancel: () -> Unit, onPaired: (Panel) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()

    var status by remember { mutableStateOf("Point the camera at the code from \"porthole pair\"") }
    var busy by remember { mutableStateOf(false) }
    var manualCode by remember { mutableStateOf("") }
    var manualHost by remember { mutableStateOf("") }

    var hasCamera by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
        )
    }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        hasCamera = it
    }
    LaunchedEffect(Unit) {
        if (autoPairUri == null && !hasCamera) askCamera.launch(Manifest.permission.CAMERA)
    }

    fun pair(uri: String) {
        if (busy) return
        val info = parsePairingUri(uri) ?: run {
            status = "That code is not a Porthole pairing code"
            return
        }
        busy = true
        status = "Pairing with ${info.host}…"
        scope.launch {
            val result = withContext(Dispatchers.IO) { claimPairing(info) }
            result.fold(
                onSuccess = { onPaired(it) },
                onFailure = {
                    busy = false
                    status = it.message ?: "Pairing failed"
                },
            )
        }
    }

    // A pairing link opened from elsewhere pairs straight away.
    //
    // Keyed on the uri itself. Holding it in `remember` instead captured only the first
    // value, so a second link arriving while this screen was already open was ignored,
    // which is exactly what happens when the app is already running.
    LaunchedEffect(autoPairUri) {
        autoPairUri?.let { pair(it) }
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        SectionLabel("Pair a panel")

        if (hasCamera && autoPairUri == null) {
            Box(Modifier.fillMaxWidth().weight(1f).padding(vertical = 12.dp)) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        val previewView = PreviewView(ctx)
                        val executor = Executors.newSingleThreadExecutor()
                        val providerFuture = ProcessCameraProvider.getInstance(ctx)

                        providerFuture.addListener({
                            val provider = providerFuture.get()
                            val preview = Preview.Builder().build().also {
                                it.setSurfaceProvider(previewView.surfaceProvider)
                            }
                            val analysis = ImageAnalysis.Builder()
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                            analysis.setAnalyzer(executor) { image ->
                                decodeQr(image)?.let { text ->
                                    image.close()
                                    previewView.post { pair(text) }
                                    return@setAnalyzer
                                }
                                image.close()
                            }

                            try {
                                provider.unbindAll()
                                provider.bindToLifecycle(
                                    lifecycleOwner,
                                    CameraSelector.DEFAULT_BACK_CAMERA,
                                    preview,
                                    analysis,
                                )
                            } catch (_: Exception) {
                                // No usable camera. The manual field below still works.
                            }
                        }, ContextCompat.getMainExecutor(ctx))

                        previewView
                    },
                )
            }
        } else {
            Spacer(Modifier.height(12.dp))
            Text("No camera access, so enter the code by hand.", color = Hull.fathom, fontSize = 13.sp)
            Spacer(Modifier.weight(1f))
        }

        Text(status, color = Hull.fathom, fontSize = 13.sp)
        Spacer(Modifier.height(10.dp))

        // The camera will not always focus, and the CLI prints the code as text for
        // exactly this reason.
        OutlinedTextField(
            value = manualHost,
            onValueChange = { manualHost = it },
            label = { Text("Panel address, host:port", fontSize = 12.sp) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            textStyle = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = manualCode,
            onValueChange = { manualCode = it.uppercase() },
            label = { Text("Pairing code", fontSize = 12.sp) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            textStyle = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
        )

        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f)) { Text("Cancel") }
            Button(
                onClick = {
                    val hostPart = manualHost.trim().ifBlank { return@Button }
                    val host = hostPart.substringBefore(':')
                    val port = hostPart.substringAfter(':', "7317").toIntOrNull() ?: 7317
                    pair("porthole://pair?h=$host&p=$port&c=${manualCode.trim()}")
                },
                enabled = !busy && manualCode.isNotBlank() && manualHost.isNotBlank(),
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Hull.brass, contentColor = Hull.hull),
            ) { Text("Pair") }
        }
    }
}

/** Decode a QR from a camera frame. Returns null for a frame with nothing in it. */
private fun decodeQr(image: ImageProxy): String? {
    return try {
        val buffer = image.planes[0].buffer
        val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
        val source = PlanarYUVLuminanceSource(
            bytes,
            image.planes[0].rowStride,
            image.height,
            0,
            0,
            image.width,
            image.height,
            false,
        )
        MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: Exception) {
        // Not-found is the normal case for most frames.
        null
    }
}
