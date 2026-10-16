import java.nio.file.*;
import java.util.*;
import jdk.jfr.consumer.*;

/** Read binary JFR without expanding repeated frame metadata into JSON. */
class JavaRecordingSummary {
    static String operation(String stack) {
        if (stack.contains("DiskIndex.mergeWith") || stack.contains("DiskIndex.copyQueryResults")) return "diskMerge";
        if (stack.contains("SimpleWordSet.") || stack.contains("MemoryIndex.addIndexEntry")) return "wordDictionary";
        if (stack.contains("JavaSearchNameEnvironment.computeClasspathLocations") || stack.contains("JavaSearchNameEnvironment.indexPackageNames")) return "classpathEnvironment";
        if (stack.contains("SourceIndexer.resolveDocument")) return "resolvedSourceIndex";
        if (stack.contains("BinaryIndexer.") || stack.contains("ClassFileReader.")) return "binaryDecode";
        if (stack.contains("SourceIndexer") || stack.contains("SourceElementParser")) return "sourceParse";
        if (stack.contains("org.eclipse.jdt.internal.core.builder") || stack.contains("org.eclipse.jdt.internal.compiler")) return "buildAndBinding";
        return "other";
    }
    static List<String> frames(RecordedEvent event, int limit) {
        RecordedStackTrace trace = event.getStackTrace();
        List<String> result = new ArrayList<>();
        if (trace != null) for (RecordedFrame frame : trace.getFrames()) {
            RecordedMethod method = frame.getMethod();
            result.add((method.getType().getName() + "." + method.getName()).replace('/', '.'));
            if (result.size() >= limit) break;
        }
        return result;
    }
    static void boundedAdd(Map<String, Long> values, String key, long amount) {
        if (values.containsKey(key) || values.size() < 10000) values.merge(key, amount, Long::sum);
    }
    static String top(Map<String, Long> values, int limit, String field) {
        StringJoiner result = new StringJoiner(",");
        values.entrySet().stream().sorted(Map.Entry.<String, Long>comparingByValue().reversed()).limit(limit).forEach(item -> result.add("{\"stack\":" + quote(item.getKey()) + "," + quote(field) + ":" + item.getValue() + "}"));
        return "[" + result + "]";
    }
    static String category(String stack) {
        if (stack.contains("AddJrtToIndex")) return "jdkIndex";
        if (stack.contains("AddJarFileToIndex")) return "jarIndex";
        for (String name : new String[]{"SourceIndexer", "AddFolderToIndex", "AddCompilationUnitToIndex", "IndexAllProject"}) if (stack.contains(name)) return "sourceIndex";
        for (String name : new String[]{"org.eclipse.jdt.internal.compiler", "org.eclipse.jdt.internal.core.builder", "org.eclipse.jdt.internal.apt"}) if (stack.contains(name)) return "build";
        for (String name : new String[]{"ImplementationsHandler", "IndexBasedHierarchyBuilder", "TypeHierarchy"}) if (stack.contains(name)) return "navigation";
        return "other";
    }
    static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32 || c > 126) out.append(String.format("\\u%04x", (int)c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("Expected JFR recording path");
        if (args[0].equals("--self-test")) {
            String[][] cases = {{"AddJrtToIndex org.eclipse.jdt.internal.compiler", "jdkIndex"}, {"AddJarFileToIndex org.eclipse.jdt.internal.compiler", "jarIndex"}, {"SourceIndexer", "sourceIndex"}, {"org.eclipse.jdt.internal.compiler.Compiler", "build"}, {"ImplementationsHandler", "navigation"}, {"ZipFile", "other"}};
            for (String[] item : cases) if (!category(item[0]).equals(item[1])) throw new AssertionError(item[0]);
            if (!operation("DiskIndex.mergeWith MemoryIndex.addIndexEntry").equals("diskMerge")) throw new AssertionError("merge precedence");
            if (!operation("SimpleWordSet.add BinaryIndexer.extractReferenceFromConstantPool").equals("wordDictionary")) throw new AssertionError("dictionary precedence");
            if (!operation("JavaSearchNameEnvironment.computeClasspathLocations SourceIndexer.resolveDocument").equals("classpathEnvironment")) throw new AssertionError("environment precedence");
            if (!operation("SourceIndexer.resolveDocument org.eclipse.jdt.internal.compiler.Compiler").equals("resolvedSourceIndex")) throw new AssertionError("resolved source precedence");
            Map<String, Long> bounded = new HashMap<>();
            for (int i = 0; i < 10010; i++) boundedAdd(bounded, "key" + i, 1);
            boundedAdd(bounded, "key0", 1);
            if (bounded.size() != 10000 || bounded.get("key0") != 2) throw new AssertionError("bounded aggregation");
            if (!quote("a\"b\\c\n").equals("\"a\\\"b\\\\c\\u000a\"")) throw new AssertionError("JSON escaping");
            System.out.println("{\"passed\":true}"); return;
        }
        Map<String, Long> counts = new LinkedHashMap<>(), hot = new HashMap<>(), detailed = new HashMap<>(), operations = new HashMap<>(), waits = new HashMap<>(), ioCounts = new HashMap<>(), ioNanos = new HashMap<>(), ioStacks = new HashMap<>(), buckets = new TreeMap<>();
        for (String name : new String[]{"jdkIndex", "jarIndex", "sourceIndex", "build", "navigation", "other"}) counts.put(name, 0L);
        long samples = 0, gcCount = 0, gcPauseNanos = 0, maxGcPauseNanos = 0;
        java.time.Instant beginning = null, ending = null;
        try (RecordingFile recording = new RecordingFile(Path.of(args[0]))) {
            while (recording.hasMoreEvents()) {
                RecordedEvent event = recording.readEvent();
                String eventName = event.getEventType().getName();
                if (beginning == null || event.getStartTime().isBefore(beginning)) beginning = event.getStartTime();
                if (ending == null || event.getEndTime().isAfter(ending)) ending = event.getEndTime();
                if (eventName.equals("jdk.ThreadPark") || eventName.equals("jdk.JavaMonitorEnter") || eventName.equals("jdk.JavaMonitorWait")) {
                    String stack = String.join(" <- ", frames(event, 20));
                    if (stack.contains("org.eclipse.jdt")) boundedAdd(waits, eventName + " " + stack, event.getDuration().toNanos());
                }
                if (eventName.equals("jdk.FileRead") || eventName.equals("jdk.FileWrite") || eventName.equals("jdk.SocketRead")) {
                    String kind = "other";
                    String ioStack = String.join(" <- ", frames(event, 20));
                    if (event.hasField("path")) {
                        String file = String.valueOf(event.getString("path"));
                        kind = file.endsWith(".index") ? "index" : file.endsWith(".jar") ? "jar" : file.endsWith(".java") ? "java" : "other";
                    }
                    if (ioStack.contains("StreamMessageProducer")) kind = "protocol";
                    String key = eventName + ":" + kind;
                    ioCounts.merge(key, 1L, Long::sum); ioNanos.merge(key, event.getDuration().toNanos(), Long::sum);
                    boundedAdd(ioStacks, key + " " + ioStack, event.getDuration().toNanos());
                }
                if (eventName.equals("jdk.GarbageCollection")) gcCount++;
                // GCPhasePause covers stop-the-world pauses, not overlapping
                // concurrent GC cycle durations. Do not add nested pause levels.
                if (eventName.equals("jdk.GCPhasePause")) {
                    long nanos = event.getDuration().toNanos();
                    gcPauseNanos += nanos; maxGcPauseNanos = Math.max(maxGcPauseNanos, nanos);
                }
                if (!eventName.equals("jdk.ExecutionSample")) continue;
                List<String> frames = frames(event, 64);
                if (frames.isEmpty()) continue;
                String full = String.join("\n", frames);
                String kind = category(full); counts.put(kind, counts.get(kind) + 1); samples++;
                operations.merge(kind + ":" + operation(full), 1L, Long::sum);
                // JFR events need not be time ordered. Use absolute buckets,
                // normalizing only after the earliest event is known.
                long bucket = event.getStartTime().getEpochSecond() / 10 * 10;
                boundedAdd(buckets, bucket + ":" + kind, 1L);
                boundedAdd(detailed, kind + " " + String.join(" <- ", frames.subList(0, Math.min(24, frames.size()))), 1L);
                String key = String.join(" <- ", frames.subList(0, Math.min(4, frames.size())));
                if (hot.containsKey(key) || hot.size() < 10000) hot.merge(key, 1L, Long::sum);
            }
        }
        StringJoiner categories = new StringJoiner(",");
        counts.forEach((name, value) -> categories.add(quote(name) + ":" + value));
        StringJoiner stacks = new StringJoiner(",");
        hot.entrySet().stream().sorted(Map.Entry.<String, Long>comparingByValue().reversed()).limit(8).forEach(item -> stacks.add("{\"stack\":" + quote(item.getKey()) + ",\"samples\":" + item.getValue() + "}"));
        Map<String, Long> relativeBuckets = new TreeMap<>();
        for (Map.Entry<String, Long> item : buckets.entrySet()) {
            int separator = item.getKey().indexOf(':');
            long offset = Long.parseLong(item.getKey().substring(0, separator)) - beginning.getEpochSecond() / 10 * 10;
            relativeBuckets.put(String.format("%04d", offset) + item.getKey().substring(separator), item.getValue());
        }
        System.out.println("{\"recordingSpanMs\":" + (beginning == null ? 0 : java.time.Duration.between(beginning, ending).toMillis()) + ",\"executionSamples\":" + samples + ",\"gcCount\":" + gcCount + ",\"gcPauseMs\":" + gcPauseNanos / 1000000 + ",\"maxGcPauseMs\":" + maxGcPauseNanos / 1000000 + ",\"sampleCategories\":{" + categories + "},\"hotStacks\":[" + stacks + "],\"hotOperations\":" + top(operations, 30, "samples") + ",\"detailedStacks\":" + top(detailed, 8, "samples") + ",\"jdtWaitStacks\":" + top(waits, 8, "totalNanos") + ",\"ioCounts\":" + top(ioCounts, 10, "events") + ",\"ioDurations\":" + top(ioNanos, 10, "totalNanos") + ",\"ioStacks\":" + top(ioStacks, 4, "totalNanos") + ",\"timeBucketsApproximate\":" + top(relativeBuckets, 100, "samples") + "}");
    }
}
