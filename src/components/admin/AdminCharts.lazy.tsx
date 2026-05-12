import type { CSSProperties } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const tooltipContentStyle: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "0.75rem",
  fontSize: "12px",
  color: "var(--foreground)",
};

const PURPLE = "#7c3aed";

// The component was previously a single AdminCharts({slot, sessionData,
// reportData, securityData}) — every call site passed all three data props
// even though each slot only renders one of them. Splitting into a tagged-
// union prop type makes the unused-data branches statically impossible.
type FilledRow = { name: string; value: number; fill: string };
type UnfilledRow = { name: string; value: number };

export type AdminChartsProps =
  | { slot: "session"; data: FilledRow[] }
  | { slot: "report"; data: FilledRow[] }
  | { slot: "security"; data: UnfilledRow[] };

export function AdminCharts(props: AdminChartsProps) {
  if (props.slot === "session") {
    return (
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={props.data}
              dataKey="value"
              nameKey="name"
              innerRadius={50}
              outerRadius={85}
              paddingAngle={2}
              strokeWidth={0}
              label={(entry: { name?: string; value?: number }) =>
                `${entry.name ?? ""} ${entry.value ?? 0}`
              }
              labelLine={false}
            >
              {props.data.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipContentStyle} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }
  if (props.slot === "report") {
    return (
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={props.data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
            <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} />
            <Tooltip
              cursor={{ fill: "var(--muted)", fillOpacity: 0.3 }}
              contentStyle={tooltipContentStyle}
            />
            <Bar dataKey="value" radius={[6, 6, 0, 0]}>
              {props.data.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={props.data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} />
          <Tooltip
            cursor={{ fill: "var(--muted)", fillOpacity: 0.3 }}
            contentStyle={tooltipContentStyle}
          />
          <Bar dataKey="value" radius={[6, 6, 0, 0]} fill={PURPLE} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
