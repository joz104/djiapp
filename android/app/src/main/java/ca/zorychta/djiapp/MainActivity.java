package ca.zorychta.djiapp;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native MediaMtx plugin BEFORE onCreate so the bridge
        // picks it up during initialization.
        registerPlugin(MediaMtxPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
