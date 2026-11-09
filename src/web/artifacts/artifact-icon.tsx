// The icon an artifact's one-word name picks, from the few Mage draws; others get a generic page.

import {
  BarChart3Icon,
  CalendarIcon,
  CodeIcon,
  FileTextIcon,
  GamepadIcon,
  ListChecksIcon,
  MapIcon,
  TableIcon,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  chart: BarChart3Icon,
  graph: BarChart3Icon,
  dashboard: BarChart3Icon,
  calendar: CalendarIcon,
  map: MapIcon,
  code: CodeIcon,
  table: TableIcon,
  list: ListChecksIcon,
  checklist: ListChecksIcon,
  game: GamepadIcon,
};

export function ArtifactIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? FileTextIcon;
  return <Icon aria-hidden className={className} />;
}
