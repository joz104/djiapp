package ca.zorychta.djiapp

import android.content.Intent
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * JS-accessible bridge for MediaMTX.
 *
 * Usage from web:
 *   const MediaMtx = window.Capacitor.Plugins.MediaMtx;
 *   await MediaMtx.start();   // fires up the foreground service
 *   await MediaMtx.stop();    // tears it down
 *   const { running } = await MediaMtx.status();
 */
@CapacitorPlugin(name = "MediaMtx")
class MediaMtxPlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        val intent = Intent(context, MediaMtxService::class.java).apply {
            action = MediaMtxService.ACTION_START
        }
        // startForegroundService is required on O+ for services that will
        // call startForeground themselves within 5 seconds.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        val ret = JSObject()
        ret.put("started", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val intent = Intent(context, MediaMtxService::class.java).apply {
            action = MediaMtxService.ACTION_STOP
        }
        context.startService(intent)
        val ret = JSObject()
        ret.put("stopped", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val ret = JSObject()
        ret.put("running", MediaMtxService.running)
        call.resolve(ret)
    }

    /**
     * Returns all non-loopback IPv4 addresses on the device. The caller picks
     * the one that matches the tablet's active hotspot / WiFi interface and
     * uses it to build the RTMP URLs for the cameras. We can't reliably
     * auto-detect the hotspot interface across OEMs, so expose everything
     * and let the UI pick (typically 192.168.x.x).
     */
    @PluginMethod
    fun getLocalIps(call: PluginCall) {
        val addrs = JSArray()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces()
            while (ifaces.hasMoreElements()) {
                val iface = ifaces.nextElement()
                if (iface.isLoopback || !iface.isUp) continue
                val a = iface.inetAddresses
                while (a.hasMoreElements()) {
                    val addr = a.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val entry = JSObject()
                        entry.put("iface", iface.name)
                        entry.put("ip", addr.hostAddress ?: "")
                        addrs.put(entry)
                    }
                }
            }
        } catch (e: Exception) {
            call.reject("Failed to enumerate interfaces: ${e.message}")
            return
        }
        val ret = JSObject()
        ret.put("addresses", addrs)
        call.resolve(ret)
    }
}
