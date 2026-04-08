# Bookmap BBO Forwarder Addon

Minimal Bookmap addon that forwards BBO and trade events to the local Python market-data sidecar via WebSocket.

## Build

Requires Bookmap's `bm-l1api.jar` on the classpath. See Bookmap API documentation for setup.

```bash
javac -cp "path/to/bm-l1api.jar" -d build src/main/java/com/nqtrader/bookmap/BboForwarder.java
jar cf nq-bbo-forwarder.jar -C build .
```

## Install

Copy `nq-bbo-forwarder.jar` to Bookmap's addon directory:
- Settings > API plugins configuration > Add > select the JAR

## Configuration

The addon connects to `ws://127.0.0.1:5010/ws/bookmap` by default. Start the Python sidecar first.
