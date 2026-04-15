package ca.zorychta.djiapp

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

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
}
