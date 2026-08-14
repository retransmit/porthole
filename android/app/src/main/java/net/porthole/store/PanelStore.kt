package net.porthole.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Serializable
data class Panel(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val token: String,
    val role: String = "control",
) {
    val baseUrl: String get() = "http://$host:$port"
    val socketUrl: String get() = "ws://$host:$port/ws"
}

/**
 * Saved panels, with their tokens encrypted by a key that lives in the Android
 * Keystore.
 *
 * The key is generated inside the keystore and marked non-exportable, so it cannot be
 * read out even from a rooted device with the app's data in hand: the ciphertext is
 * useless without hardware that will not surrender the key. That matters more here than
 * in most apps, because a token is not a password to a service, it is the ability to run
 * commands on somebody's desktop.
 */
class PanelStore(context: Context) {

    private val prefs = context.getSharedPreferences("porthole.panels", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    private companion object {
        const val KEY_ALIAS = "porthole.panels.v1"
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        const val BLOB = "blob"
    }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val body = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        // The IV is generated per encryption and stored alongside; it is not a secret.
        return Base64.encodeToString(cipher.iv + body, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String? = try {
        val all = Base64.decode(encoded, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(
            Cipher.DECRYPT_MODE,
            secretKey(),
            GCMParameterSpec(TAG_BITS, all, 0, IV_BYTES),
        )
        String(cipher.doFinal(all, IV_BYTES, all.size - IV_BYTES), Charsets.UTF_8)
    } catch (_: Exception) {
        // A rotated or invalidated key means the stored panels are unreadable. Losing
        // them is recoverable by pairing again; crashing on launch is not.
        null
    }

    fun list(): List<Panel> {
        val blob = prefs.getString(BLOB, null) ?: return emptyList()
        val plain = decrypt(blob) ?: return emptyList()
        return try {
            json.decodeFromString<List<Panel>>(plain)
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun persist(panels: List<Panel>) {
        prefs.edit().putString(BLOB, encrypt(json.encodeToString(panels))).apply()
    }

    fun add(panel: Panel) {
        // Pairing the same host twice replaces rather than duplicates it.
        persist(list().filterNot { it.host == panel.host && it.port == panel.port } + panel)
    }

    fun remove(id: String) = persist(list().filterNot { it.id == id })

    fun get(id: String): Panel? = list().firstOrNull { it.id == id }

    fun clear() = prefs.edit().remove(BLOB).apply()
}
