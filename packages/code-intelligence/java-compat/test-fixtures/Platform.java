package org.eclipse.core.runtime;
public final class Platform {
    public static int state = 32;
    public static org.osgi.framework.Bundle getBundle(String name) { return state < 0 ? null : () -> state; }
}
