import { MeteringPointStatus } from '@salzburg-ag-ds/at.salzburg-ag.ds.energycommunities.market-processes-client';
import { getMeteringPointsStatusText } from '@services/utils/translation';

interface AssignmentRow {
  id?: unknown;
  status?: string;
}

interface KepRow {
  meteringPointId?: unknown;
  activationStatus?: unknown;
  hasBeenActivated?: unknown;
}

export function enrichMeteringPointStatus(data: Record<string, unknown>): void {
  const rows = (data['community-metering-points'] as { items?: AssignmentRow[] } | undefined)
    ?.items;
  const kep = (data['community-kep-metering-points'] as { items?: KepRow[] } | undefined)?.items;
  if (!Array.isArray(rows) || !Array.isArray(kep)) return;
  const kepById = new Map(kep.map((entry) => [entry.meteringPointId, entry] as const));
  for (const row of rows) {
    const matched = kepById.get(row.id);
    const status =
      (matched?.activationStatus as MeteringPointStatus | undefined) ??
      MeteringPointStatus.NOT_ACTIVE;
    row.status = getMeteringPointsStatusText(status, Boolean(matched?.hasBeenActivated));
  }
}
