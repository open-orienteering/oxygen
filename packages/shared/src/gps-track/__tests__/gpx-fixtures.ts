/** Hand-written GPX documents for `gpx.test.ts` (docs/map-gps-tracks.md §2). */

/** GPX 1.1 as Garmin writes it: metadata, a waypoint, one track with two segments, extensions with a namespace prefix. */
export const GPX_11_GARMIN = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" creator="Garmin Connect" version="1.1">
  <metadata>
    <name>Skidspår &amp; slingor</name>
    <time>2026-01-17T09:12:03Z</time>
  </metadata>
  <wpt lat="59.30000" lon="18.10000"><name>Parkering</name></wpt>
  <trk>
    <name>Morning ski</name>
    <type>cross_country_skiing</type>
    <trkseg>
      <trkpt lat="59.3001000" lon="18.1001000">
        <ele>31.4</ele>
        <time>2026-01-17T09:12:03Z</time>
        <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>121</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lat="59.3002000" lon="18.1002000"><ele>31.8</ele><time>2026-01-17T09:12:05.500Z</time></trkpt>
      <trkpt lat="59.3003000" lon="18.1003000"><ele>32.0</ele><time>2026-01-17T10:12:07+01:00</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="59.3010000" lon="18.1010000"><ele>35</ele><time>2026-01-17T09:20:00Z</time></trkpt>
      <trkpt lat="59.3011000" lon="18.1011000"><ele>35.5</ele><time>2026-01-17T09:20:02Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>
`;

/** GPX 1.0: `time` and `name` at the root, a route, a second track without a name, `<trkpt>` without `ele`/`time`. */
export const GPX_10 = `<?xml version="1.0"?>
<gpx version="1.0" creator="GPSBabel" xmlns="http://www.topografix.com/GPX/1/0">
  <name>Old logger</name>
  <time>2019-02-03T10:00:00Z</time>
  <wpt lat="60.0" lon="15.0"><name>A</name></wpt>
  <wpt lat="60.1" lon="15.1"/>
  <rte>
    <name>Planned loop</name>
    <rtept lat="60.00" lon="15.00"><ele>100</ele></rtept>
    <rtept lat="60.01" lon="15.01"/>
  </rte>
  <trk>
    <name>Logged</name>
    <trkseg>
      <trkpt lat="60.0000" lon="15.0000"><time>2019-02-03T10:00:00Z</time></trkpt>
      <trkpt lat="60.0001" lon="15.0001"><time>2019-02-03T10:00:01Z</time></trkpt>
    </trkseg>
  </trk>
  <trk>
    <trkseg>
      <trkpt lat="60.0100" lon="15.0100"/>
      <trkpt lat="60.0101" lon="15.0101"/>
      <trkpt lat="60.0102" lon="15.0102"/>
    </trkseg>
  </trk>
</gpx>
`;

/** A segment with no points and a point whose coordinates are not numbers. */
export const GPX_EMPTY_SEGMENT_AND_BAD_POINT = `<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>T</name>
    <trkseg></trkseg>
    <trkseg>
      <trkpt lat="59.0" lon="18.0"/>
      <trkpt lat="north" lon="18.0"/>
      <trkpt lat="91" lon="18.0"/>
      <trkpt lat="59.0001" lon="18.0001"><time>not a time</time><ele>high</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

/** Waypoints only. */
export const GPX_WAYPOINTS_ONLY = `<gpx version="1.1" creator="x"><wpt lat="1" lon="2"/><wpt lat="3" lon="4"/></gpx>`;

/** Well-formed XML that is not GPX (a KML document). */
export const KML = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>`;

/** Truncated mid-file, as an interrupted download leaves it. */
export const GPX_TRUNCATED = `<gpx version="1.1" creator="x"><trk><trkseg><trkpt lat="59.0" lon="18.0"><time>2026-01-17T09:12:03Z</time></trkpt><trkpt lat="59.0`;
