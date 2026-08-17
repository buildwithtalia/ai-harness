"use client"

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type Row = {
  model: string
  passRate: number
  meanScore: number
  costUsd: number
  p50: number
  p95: number
}

const AXIS = "var(--muted-foreground)"
const GRID = "var(--border)"
const BARS = {
  passRate: "var(--chart-1)",
  score: "var(--chart-2)",
  cost: "var(--chart-4)",
  p50: "var(--chart-3)",
  p95: "var(--chart-5)",
}

function shortLabel(model: string) {
  const [, name] = model.split("/")
  return name ?? model
}

export function CompareChart({ data }: { data: Row[] }) {
  const chartData = data.map((d) => ({ ...d, label: shortLabel(d.model) }))

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quality</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" stroke={AXIS} fontSize={11} />
                <YAxis stroke={AXIS} fontSize={11} unit="%" domain={[0, 100]} />
                <Tooltip />
                <Legend />
                <Bar dataKey="passRate" name="Pass %" fill={BARS.passRate} radius={[4, 4, 0, 0]} />
                <Bar dataKey="meanScore" name="Score (×100)" fill={BARS.score} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" stroke={AXIS} fontSize={11} />
                <YAxis stroke={AXIS} fontSize={11} unit="$" />
                <Tooltip formatter={(v) => `$${Number(v).toFixed(4)}`} />
                <Bar dataKey="costUsd" name="Total cost" fill={BARS.cost} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Latency (ms)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" stroke={AXIS} fontSize={11} />
                <YAxis stroke={AXIS} fontSize={11} unit="ms" />
                <Tooltip />
                <Legend />
                <Bar dataKey="p50" name="p50" fill={BARS.p50} radius={[4, 4, 0, 0]} />
                <Bar dataKey="p95" name="p95" fill={BARS.p95} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
