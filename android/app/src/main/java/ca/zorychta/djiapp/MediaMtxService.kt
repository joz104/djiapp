package ca.zorychta.djiapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import kotlin.concurrent.thread

/**
 * Foreground service that runs the bundled MediaMTX RTMP server.
 *
 * The binary ships in jniLibs/arm64-v8a/libmediamtx.so — Android extracts it
 * into the app's nativeLibraryDir at install time, which is a read-only,
 * exec-allowed directory (the only place W^X on Android Q+ permits exec).
 *
 * The mediamtx.yml config is copied from assets/ into the app's private files
 * dir on first start so MediaMTX has a persistent writable config path.
 */
class MediaMtxService : Service() {

    companion object {
        private const val TAG = "MediaMtxService"
        private const val CHANNEL_ID = "mediamtx_service"
        private const val NOTIF_ID = 4201

        const val ACTION_START = "ca.zorychta.djiapp.MEDIAMTX_START"
        const val ACTION_STOP = "ca.zorychta.djiapp.MEDIAMTX_STOP"

        @Volatile
        var running: Boolean = false
            private set
    }

    private var process: Process? = null
    private var logThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startMediaMtx()
            ACTION_STOP -> {
                stopMediaMtx()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> startMediaMtx()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopMediaMtx()
        super.onDestroy()
    }

    private fun startMediaMtx() {
        if (running) {
            Log.i(TAG, "MediaMTX already running, ignoring start")
            return
        }

        val notification = buildNotification("Starting RTMP server…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // connectedDevice matches the manifest declaration. The service
            // exists to ingest streams from BLE-connected cameras, which
            // Android 14+ accepts as a valid use of this FGS type without
            // needing a MediaProjection consent token.
            startForeground(
                NOTIF_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            )
        } else {
            startForeground(NOTIF_ID, notification)
        }

        try {
            val binary = File(applicationInfo.nativeLibraryDir, "libmediamtx.so")
            if (!binary.exists()) {
                Log.e(TAG, "libmediamtx.so not found at ${binary.absolutePath}")
                updateNotification("Error: binary missing")
                return
            }

            val configPath = copyConfigIfNeeded()

            Log.i(TAG, "Launching MediaMTX: $binary $configPath")
            val pb = ProcessBuilder(binary.absolutePath, configPath)
                .redirectErrorStream(true)
                .directory(filesDir)
            process = pb.start()
            running = true
            updateNotification("RTMP :1935 · HLS :8888")

            logThread = thread(start = true, name = "mediamtx-log") {
                try {
                    val reader = BufferedReader(InputStreamReader(process!!.inputStream))
                    reader.useLines { lines ->
                        lines.forEach { Log.i(TAG, "mediamtx: $it") }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "log pump ended: ${e.message}")
                }
                running = false
                Log.i(TAG, "MediaMTX exited")
            }
        } catch (e: Exception) {
            Log.e(TAG, "failed to start MediaMTX", e)
            updateNotification("Error: ${e.message}")
            running = false
        }
    }

    private fun stopMediaMtx() {
        val p = process ?: return
        try {
            Log.i(TAG, "Destroying MediaMTX process")
            p.destroy()
            p.waitFor()
        } catch (e: Exception) {
            Log.w(TAG, "stop error: ${e.message}")
        }
        process = null
        running = false
    }

    private fun copyConfigIfNeeded(): String {
        // Always overwrite — config may change between releases.
        val out = File(filesDir, "mediamtx.yml")
        assets.open("mediamtx.yml").use { input ->
            FileOutputStream(out).use { output ->
                input.copyTo(output)
            }
        }
        return out.absolutePath
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "RTMP Preview Server",
                    NotificationManager.IMPORTANCE_LOW
                )
                channel.description = "Runs the on-device RTMP server for camera live preview"
                channel.setSound(null, null)
                nm.createNotificationChannel(channel)
            }
        }
    }

    private fun buildNotification(text: String): Notification {
        ensureChannel()
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pending = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Field Multi-Cam preview")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(text))
    }
}
