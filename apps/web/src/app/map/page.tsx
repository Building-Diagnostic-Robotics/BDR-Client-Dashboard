"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { PortalShell } from "../../components/portal-shell";
import { getClient } from "../../lib/client-api";

const asFile = { parse(value: unknown) { return value as { url: string }; } };

function MapView() {
  const prefix = useSearchParams().get("prefix") || "";
  const [moisture, setMoisture] = useState(true);
  const [severity, setSeverity] = useState("all");
  const [section, setSection] = useState("");
  const [anomalyType, setAnomalyType] = useState("");
  const [aerial, setAerial] = useState<string | null>(null);
  const [moistureUrl, setMoistureUrl] = useState<string | null>(null);
  const [features, setFeatures] = useState<Array<{ type?: string | undefined; severity?: string | undefined; section?: string | undefined }>>([]);
  useEffect(() => {
    if (!prefix) return;
    const root = prefix.replace(/\/?$/, "/");
    const load = (key: string, set: (url: string) => void) => {
      getClient(`/bff/portal/file?prefix=${encodeURIComponent(prefix)}&key=${encodeURIComponent(key)}`, asFile)
        .then((file) => set(file.url))
        .catch(() => set(""));
    };
    load(`${root}reportgen/client_portal/map/aerial.png`, setAerial);
    load(`${root}reportgen/client_portal/map/moisture.png`, setMoistureUrl);
    getClient(`/bff/portal/file?prefix=${encodeURIComponent(prefix)}&key=${encodeURIComponent(`${root}reportgen/client_portal/map/anomalies.geojson`)}`, asFile)
      .then((file) => fetch(file.url).then((response) => response.json()))
      .then((data: { features?: Array<{ properties?: { anomalyType?: string; type?: string; severity?: string; section?: string } }> }) => {
        setFeatures((data.features ?? []).map((feature) => ({
          type: feature.properties?.anomalyType || feature.properties?.type,
          severity: feature.properties?.severity,
          section: feature.properties?.section,
        })));
      })
      .catch(() => setFeatures([]));
  }, [prefix]);
  const shown = features.filter((feature) => {
    if (anomalyType && feature.type !== anomalyType) return false;
    if (severity !== "all" && feature.severity !== severity) return false;
    if (section && feature.section !== section) return false;
    return true;
  });

  return (
    <PortalShell>
      <section>
        <p><Link href={`/buildings/view?prefix=${encodeURIComponent(prefix)}`}>Building</Link></p>
        <h1>Roof map</h1>
        <p>Filters apply to the published moisture and anomaly layers for this visit.</p>
        <div className="map-frame">
          {aerial ? <img src={aerial} alt="Aerial" /> : <p>No aerial has been published for this visit.</p>}
          {moisture && moistureUrl ? <img className="moisture-layer" src={moistureUrl} alt="Moisture" /> : null}
        </div>
        <label><input type="checkbox" checked={moisture} onChange={(e) => setMoisture(e.target.checked)} /> Moisture</label>
        <label>
          Anomaly type
          <input value={anomalyType} onChange={(e) => setAnomalyType(e.target.value)} />
        </label>
        <label>
          Severity
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="all">All</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label>
          Section
          <input value={section} onChange={(e) => setSection(e.target.value)} />
        </label>
        <p>{shown.length} of {features.length} anomalies match these filters.</p>
        <ul>
          {shown.map((feature, index) => (
            <li key={`${feature.section}-${index}`}>{feature.type || "Anomaly"} · {feature.severity || "unspecified"} · {feature.section || "no section"}</li>
          ))}
        </ul>
      </section>
    </PortalShell>
  );
}

export default function MapPage() {
  return (
    <Suspense>
      <MapView />
    </Suspense>
  );
}
