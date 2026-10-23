package com.acme.app;

import com.acme.util.Util;

// com.acme.util.Util exists in core (a dependency) and legacy (not one).
public class App {
    String run() { return Util.name(); }
}
