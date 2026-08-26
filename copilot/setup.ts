import { Sidepilot, type PageDefinition, type PageContext } from '@sidepilot/sdk';
import { goto, preloadCode } from '$app/navigation';
import type { QueryClient } from '@tanstack/svelte-query';
import {
  MeteringPointType,
  getCommunityMeteringPointAssignmentsWa,
} from '@salzburg-ag-ds/at.salzburg-ag.ds.energycommunities.community-management-client';
import {
  registerMeteringPoints,
  type RegisterMeteringPointsBody,
} from '@salzburg-ag-ds/at.salzburg-ag.ds.energycommunities.market-processes-client';
import { enrichMeteringPointStatus } from '@lib/copilot/metering-point-status';
import { format, startOfTomorrow } from 'date-fns';
import { auth } from '@lib/stores';
import { PUBLIC_SIDEPILOT_URL } from '@constants/configs';
import { addNotification } from '@services/stores/notifications';

let instance: Sidepilot | null = null;
let queryClientRef: QueryClient | null = null;

export function getSidepilot(): Sidepilot {
  if (instance) return instance;

  instance = new Sidepilot({
    serverUrl: PUBLIC_SIDEPILOT_URL,
    useWebSocket: true,
    autoReconnect: true,
    getToken: async () => {
      const token = await auth.getToken();
      return typeof token === 'string' ? token : null;
    },
  });

  instance.commands.registerAll({
    navigate: ({ to }) => {
      console.log('[Sidepilot:nav] goto called:', to);
      return goto(to);
    },
    update_params: ({ params }) => {
      if (!params || typeof params !== 'object') return;
      const url = new URL(window.location.href);
      for (const [key, value] of Object.entries(params)) {
        const stale = [...url.searchParams.keys()].filter(
          (k) => k.toLowerCase() === key.toLowerCase()
        );
        for (const k of stale) url.searchParams.delete(k);
        if (value !== '' && value !== null) {
          url.searchParams.set(key, value);
        }
      }
      return goto(url.pathname + url.search, { invalidateAll: true });
    },
    show_notification: ({ message, level }) => {
      const typeMap: Record<string, 'success' | 'warning' | 'fail' | 'info'> = {
        success: 'success',
        info: 'info',
        error: 'fail',
      };
      addNotification({
        type: typeMap[level] ?? 'info',
        title: 'enox.intelligence',
        content: message,
        dismissible: true,
        timeout: 6000,
      });
    },
    refresh_resource: ({ resource }) => {
      if (queryClientRef) {
        queryClientRef.invalidateQueries({ queryKey: [resource] });
      }
    },
  });

  instance.state.registerSnapshot(() =>
    queryClientRef ? (extractVisibleData(queryClientRef, '/', undefined) ?? {}) : {}
  );

  instance.client.contextEnricher = (ctx) => {
    if (!queryClientRef) return ctx;
    const visibleData = extractVisibleData(queryClientRef, '/', undefined);
    if (visibleData && Object.keys(visibleData).length > 0) {
      console.log('[Sidepilot] Injecting visible data:', Object.keys(visibleData));
      return { ...ctx, visibleData };
    }
    return ctx;
  };

  instance.registerAction({
    id: 'activateMeteringPoint',
    description:
      'Activate (register) one or more metering points in the community. Only points with status NOT_ACTIVE, REJECTED or ARCHIVED can be activated. Use the internal meteringPointId (UUID), not the AT-Zählpunktnummer.',
    params: {
      communityId: { type: 'string', description: 'Community ID' },
      meteringPointActivations: {
        type: 'string',
        description:
          'JSON array of objects, one per metering point, each with: meteringPointId (internal UUID, NOT the AT-Zählpunktnummer), and optionally participationFactor (number 1-100, defaults to 100), startDate ("yyyy-MM-dd", defaults to tomorrow), share (number 1-100, only for static communities) and notifyMember (boolean, defaults to true — set false only when the user explicitly asked not to notify the member). The energy direction (consumption/production) is determined automatically from the stored metering point type — do NOT ask the user for it.',
      },
    },
    confirmMessage: (params) => {
      const items = JSON.parse((params['meteringPointActivations'] as string) || '[]') as unknown[];
      return `${items.length} Zählpunkt(e) aktivieren`;
    },
    handler: async (params) => {
      const communityId = params['communityId'] as string;
      const activations = JSON.parse(
        (params['meteringPointActivations'] as string) || '[]'
      ) as Array<{
        meteringPointId: string;
        energyDirection?: string;
        participationFactor?: number;
        startDate?: string;
        share?: number;
        notifyMember?: boolean;
      }>;

      const assignments = await getCommunityMeteringPointAssignmentsWa({ path: { communityId } });
      if (assignments.error || !assignments.data) {
        return {
          success: false,
          message:
            'Die Zählpunkt-Zuordnungen konnten nicht geladen werden, daher ist die Energierichtung gerade nicht bestimmbar. Bitte erneut versuchen.',
          activatedCount: 0,
        };
      }
      const storedTypeById = new Map(assignments.data.map((a) => [a.id, a.meteringPointType]));
      const resolveDirection = (a: (typeof activations)[number]) => {
        const stored = storedTypeById.get(a.meteringPointId);
        const source = stored ?? a.energyDirection;
        if (source === MeteringPointType.CONSUMPTION) return MeteringPointType.CONSUMPTION;
        if (source === MeteringPointType.PRODUCTION) return MeteringPointType.PRODUCTION;
        return null;
      };

      const unresolved = activations.filter((a) => resolveDirection(a) === null);
      if (unresolved.length > 0) {
        return {
          success: false,
          message: `Energierichtung konnte nicht bestimmt werden für: ${unresolved
            .map((a) => a.meteringPointId)
            .join(
              ', '
            )}. Für diese Zählpunkte energyDirection ("CONSUMPTION" oder "PRODUCTION") explizit angeben.`,
          activatedCount: 0,
        };
      }

      const defaultStartDate = format(startOfTomorrow(), 'yyyy-MM-dd');
      const body: RegisterMeteringPointsBody = activations.map((a) => ({
        meteringPointId: a.meteringPointId,
        startDate: a.startDate ?? defaultStartDate,
        energyDirection: resolveDirection(a) as MeteringPointType,
        participationFactor: a.participationFactor ?? 100,
        ...(a.share !== undefined ? { share: a.share } : {}),
        ...(a.notifyMember !== undefined ? { notifyMember: a.notifyMember } : {}),
      }));

      try {
        await registerMeteringPoints({ path: { communityId }, body, throwOnError: true });
        if (queryClientRef) {
          queryClientRef.invalidateQueries({ queryKey: ['community-kep-metering-points'] });
          queryClientRef.invalidateQueries({ queryKey: ['community-metering-points'] });
        }
        return {
          success: true,
          message: `${body.length} Zählpunkt(e) aktiviert`,
          activatedCount: body.length,
        };
      } catch (error) {
        return {
          success: false,
          message: `Aktivierung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
          activatedCount: 0,
        };
      }
    },
  });

  return instance;
}

export function setQueryClient(qc: QueryClient): void {
  queryClientRef = qc;
}

export function destroySidepilot(): void {
  instance?.destroy();
  instance = null;
  queryClientRef = null;
  copilotRoutesPreloaded = false;
}

let copilotRoutesPreloaded = false;

export async function preloadCopilotRoutes(
  pages: PageDefinition[],
  communityId: string | undefined
): Promise<void> {
  if (copilotRoutesPreloaded) return;
  copilotRoutesPreloaded = true;
  const routes = pages.map((p) => p.route);
  if (communityId) {
    const base = `/de/${communityId}`;
    routes.push(
      `${base}/members/add`,
      `${base}/members/_`,
      `${base}/members/_/metering-points/add`,
      `${base}/my-invoices/_`
    );
  }
  await Promise.all(
    routes.map(async (route) => {
      try {
        await preloadCode(route);
      } catch (error) {
        console.warn('[Sidepilot:nav] preloadCode failed:', route, error);
      }
    })
  );
}

interface PageContextInput {
  pathname: string;
  searchParams?: URLSearchParams;
  communityId: string | undefined;
}

export function buildPageContext(input: PageContextInput): PageContext {
  const { pathname, searchParams, communityId } = input;

  let route = pathname;
  if (communityId) {
    const prefix = `/de/${communityId}`;
    if (pathname.startsWith(prefix)) {
      route = pathname.slice(prefix.length) || '/';
    }
  }

  let formState: Record<string, unknown> | undefined;
  if (searchParams) {
    const params: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      params[key] = value;
    });
    if (Object.keys(params).length > 0) {
      formState = params;
    }
  }

  const pageName = routeToPageName(route);
  const entityType = routeToEntityType(route);

  const selectionSources = communityId
    ? [
        {
          id: 'community-members',
          label: 'Mitglieder',
          dataPath: 'community-members',
          idPath: 'participantId',
          routeTemplate: `/de/${communityId}/members/{selectedId}`,
          pageName: 'Mitglied Detail',
        },
      ]
    : undefined;

  return {
    route: pathname,
    pageName,
    entityType,
    entityId: communityId,
    formState,
    selectionSources,
  };
}

function routeToPageName(route: string): string {
  if (route.startsWith('/dashboard/community')) return 'Unsere Gemeinschaft';
  if (route.startsWith('/dashboard/production')) return 'Erzeugung';
  if (route.startsWith('/dashboard/consumption')) return 'Verbrauch';
  if (route.startsWith('/dashboard')) return 'Dashboard';
  if (route.match(/\/members\/[^/]+\/metering-points\/add/)) return 'Zählpunkt hinzufügen';
  if (route.startsWith('/members/add')) return 'Mitglied hinzufügen';
  if (route.match(/\/members\/[^/]+/)) return 'Mitglied Detail';
  if (route.startsWith('/members')) return 'Mitglieder';
  if (route.startsWith('/metering-points')) return 'Zählpunkte';
  if (route.match(/\/my-invoices\/[^/]+/)) return 'Rechnung Detail';
  if (route.startsWith('/my-invoices')) return 'Meine Rechnungen';
  if (route.startsWith('/new-invoices')) return 'Abrechnung';
  if (route.startsWith('/invoices')) return 'Abrechnung bis 2025';
  if (route.startsWith('/energy-data')) return 'Energiedaten';
  if (route.startsWith('/profile')) return 'Mein Profil';
  if (route.startsWith('/faq-support')) return 'FAQ / Support';
  return route;
}

function routeToEntityType(route: string): string | undefined {
  if (route.match(/\/members\/[^/]+/)) return 'participant';
  if (route.startsWith('/members')) return 'participant';
  if (route.startsWith('/metering-points')) return 'meteringPoint';
  if (route.match(/\/my-invoices\/[^/]+/)) return 'invoice';
  if (
    route.startsWith('/my-invoices') ||
    route.startsWith('/invoices') ||
    route.startsWith('/new-invoices')
  )
    return 'invoice';
  if (route.startsWith('/dashboard')) return 'community';
  return undefined;
}

const COMMUNITY_ROUTE_PATTERN =
  /^\/[a-z]{2}\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

function currentCommunityIdFromPath(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return COMMUNITY_ROUTE_PATTERN.exec(window.location.pathname)?.[1];
}

function pruneParticipantPermissions(data: Record<string, unknown>): void {
  try {
    const currentId = currentCommunityIdFromPath();
    if (!currentId) return;
    const permissions = data['participant-permissions'] as
      { communities?: Record<string, { community?: { communityName?: unknown } }> } | undefined;
    const communities = permissions?.communities;
    if (!communities || typeof communities !== 'object') return;
    if (!communities[currentId]) return;
    const otherCommunityNames: unknown[] = [];
    for (const [id, entry] of Object.entries(communities)) {
      if (id === currentId) continue;
      const name = entry?.community?.communityName;
      if (name) otherCommunityNames.push(name);
      delete communities[id];
    }
    if (otherCommunityNames.length > 0) {
      (permissions as Record<string, unknown>)['otherCommunityNames'] = otherCommunityNames;
    }
  } catch {
    // silent
  }
}

function extractVisibleData(
  qc: QueryClient,
  _route: string,
  _communityId: string | undefined
): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {};

  const SKIP_KEYS = new Set(['user', 'user-communities']);

  try {
    const allQueries = qc.getQueryCache().findAll();

    for (const query of allQueries) {
      const key = query.queryKey;
      const raw = query.state.data as { data?: unknown } | unknown;
      if (!raw || !Array.isArray(key) || query.state.status !== 'success') continue;

      const observers = (query as { observers?: unknown[] }).observers?.length ?? 0;
      if (observers === 0) continue;

      const d = typeof raw === 'object' && raw !== null && 'data' in raw ? raw.data : raw;
      const name = key[0] as string;

      if (SKIP_KEYS.has(name)) continue;

      if (Array.isArray(d)) {
        const items = d
          .slice(0, 20)
          .map((item: unknown) => extractDeep(item, 0))
          .filter(Boolean);
        if (items.length > 0) {
          data[name] = { total: d.length, items };
        }
      } else if (d && typeof d === 'object') {
        const extracted = extractDeep(d, 0);
        if (
          extracted &&
          typeof extracted === 'object' &&
          Object.keys(extracted as Record<string, unknown>).length > 0
        ) {
          data[name] = extracted;
        }
      } else if (d !== undefined && d !== null) {
        data[name] = d;
      }
    }
  } catch {
    // silent
  }

  enrichMeteringPointStatus(data);
  pruneParticipantPermissions(data);

  return Object.keys(data).length > 0 ? data : undefined;
}

function extractDeep(obj: unknown, depth = 0): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj === 'number' || typeof obj === 'string' || typeof obj === 'boolean') return obj;
  if (depth > 3) return undefined;

  if (Array.isArray(obj)) {
    const items = obj
      .slice(0, depth <= 1 ? 20 : 5)
      .map((item) => extractDeep(item, depth + 1))
      .filter(Boolean);
    if (items.length === 0) return undefined;
    const summary: Record<string, unknown> = { count: obj.length, sample: items };
    return summary;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    const isAssignmentRecord = 'meteringPointType' in obj && 'number' in obj;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_') || k === 'headers' || k === 'request' || k === 'response') continue;
      const extracted = extractDeep(v, depth + 1);
      if (extracted !== undefined) {
        result[k === 'contactName' && isAssignmentRecord ? 'assignmentContactName' : k] = extracted;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  return undefined;
}

interface Permissions {
  isAllowedToAccessCommunityDashboard: boolean | undefined;
  isAllowedToAccessMeteringPoints: boolean | undefined;
  isAllowedToAccessInvoices: boolean | undefined;
  isAllowedToAccessMembers: boolean | undefined;
  isAllowedToWriteMembers: boolean | undefined;
  isAllowedToWriteInvoices: boolean | undefined;
}

export function buildPageRegistry(
  communityId: string | undefined,
  permissions: Permissions
): PageDefinition[] {
  if (!communityId) return [];

  const base = `/de/${communityId}`;
  const isAdmin = permissions.isAllowedToWriteMembers === true;
  const pages: PageDefinition[] = [];

  if (permissions.isAllowedToAccessCommunityDashboard) {
    pages.push({
      route: `${base}/dashboard/community`,
      name: 'Unsere Gemeinschaft',
      description:
        'Übersicht der Energiegemeinschaft mit Kennzahlen, Teilnehmeranzahl und Gesamtstatistiken.',
      entityType: 'community',
      capabilities: [{ type: 'view', description: 'Community-Übersicht mit Kennzahlen anzeigen' }],
    });
  }

  if (permissions.isAllowedToAccessCommunityDashboard) {
    pages.push({
      route: `${base}/dashboard/production`,
      name: isAdmin ? 'Erzeugung' : 'Meine Erzeugung',
      description:
        'Erzeugungsdaten: Beitrag zur Energiegemeinschaft, Gemeinschaftsenergie, geteilte Energie, Einspeisung ins Netz.',
      entityType: 'community',
      capabilities: [{ type: 'view', description: 'Erzeugungsdaten und -statistiken anzeigen' }],
    });
  }

  if (permissions.isAllowedToAccessCommunityDashboard) {
    pages.push({
      route: `${base}/dashboard/consumption`,
      name: isAdmin ? 'Verbrauch' : 'Mein Verbrauch',
      description: 'Verbrauchsdaten: Gemeinschaftsstrom, Netzbezug, Eigenverbrauch, Autarkiegrad.',
      entityType: 'community',
      capabilities: [{ type: 'view', description: 'Verbrauchsdaten und -statistiken anzeigen' }],
    });
  }

  pages.push({
    route: `${base}/my-invoices`,
    name: 'Meine Rechnungen',
    description:
      'Persönliche Rechnungen und Gutschriften der Energiegemeinschaft mit PDF/ZIP-Download. Detailansicht pro Rechnung unter /my-invoices/{id}.',
    entityType: 'invoice',
    capabilities: [{ type: 'view', description: 'Eigene Rechnungen und Gutschriften anzeigen' }],
  });

  if (permissions.isAllowedToAccessInvoices) {
    pages.push({
      route: `${base}/new-invoices`,
      name: 'Abrechnung',
      description:
        'Aktuelle Abrechnung der Energiegemeinschaft mit Abrechnungsperioden. Der Assistent kann Abrechnungsperioden und veröffentlichte Rechnungen lesen und den Abrechnungsablauf selbst ausführen (jeweils nach Bestätigung durch den Nutzer): Vorschau berechnen (previewBillingPeriod), Abrechnungsperiode erstellen (createBillingPeriod) und veröffentlichen (publishBillingPeriod). Statusablauf: OPEN → PREVIEW → IN_GENERATION → READY_TO_PUBLISH → PUBLISHED. Löschen von Abrechnungsperioden und DATEV-/SEPA-/Excel-/ZIP-Exporte führt ausschließlich der Nutzer auf dieser Seite aus. Tabs über den URL-Parameter "invoices": 0 Zusammenfassung, 1 Abnehmer, 2 Einspeiser, 3 Weitere Beiträge (nur bei Mitgliedsbeitragsdaten). Nach Schreibaktionen die Seitendaten über refresh_resource mit "billing-periods" aktualisieren. Der Leerzustand "Abrechnung nicht verfügbar" ist normal (noch keine vollständige Abrechnungsperiode); die erste Periode kann direkt hier angelegt werden.',
      entityType: 'invoice',
      capabilities: [
        {
          type: 'view',
          description: 'Abrechnungsperioden und veröffentlichte Rechnungen anzeigen',
        },
      ],
    });

    pages.push({
      route: `${base}/invoices`,
      name: 'Abrechnung bis 2025',
      description:
        'Alt-Abrechnung (Legacy-System bis 2025) mit alten Abrechnungszyklen, Veröffentlichung und Dokument-Downloads. Für den Assistenten nur ansehen und erklären — kein API-Zugriff auf Alt-Abrechnungsdaten.',
      entityType: 'invoice',
      capabilities: [{ type: 'view', description: 'Alte Abrechnungszyklen anzeigen' }],
    });
  }

  if (permissions.isAllowedToWriteInvoices) {
    pages.push({
      route: `${base}/energy-data`,
      name: 'Energiedaten',
      description:
        'Energiedaten der Gemeinschaft exportieren, Datenqualität prüfen, CSV-Downloads.',
      entityType: 'community',
      capabilities: [{ type: 'view', description: 'Energiedaten exportieren und einsehen' }],
    });
  }

  if (permissions.isAllowedToAccessMembers) {
    pages.push({
      route: `${base}/members`,
      name: 'Mitglieder',
      description:
        'Liste aller Mitglieder der Energiegemeinschaft. Suche nach Name, E-Mail oder Telefon. Die Mitgliederliste enthält KEINE Kundennummer und kann nicht danach durchsucht werden; die Kundennummer steht nur auf der Mitglied-Detailseite bzw. über getParticipantWA. Mitglieder hinzufügen und verwalten. Auf der Mitglied-Detailseite (/members/{id}) steht der Name des Mitglieds im "participant"-Datensatz; assignmentContactName in Zählpunkt-Zuordnungen ist der Zuordnungs-Kontakt und NIE der Mitgliedsname. Die Mitgliederliste und die Detailseiten zeigen den Administrator-Status NICHT zuverlässig an; um Administratoren zu ermitteln, für Mitglieder mit Account die Rollen-API nutzen (getAccountRoles mit der accountId aus den Mitglied-Detaildaten) statt alle Detailseiten durchzugehen.',
      entityType: 'participant',
      capabilities: [
        { type: 'view', description: 'Mitgliederliste anzeigen' },
        { type: 'select', entityType: 'participant' },
      ],
    });
  }

  if (permissions.isAllowedToAccessMeteringPoints) {
    pages.push({
      route: `${base}/metering-points`,
      name: 'Zählpunkte',
      description:
        'Alle Zählpunkte der Energiegemeinschaft mit Status, Prozess, Typ, Tarif, Kontaktname. Die Spalte "Status" ist der Aktivierungsstatus (activationStatus: ACTIVE/Aktiv, SCHEDULED/Geplant, ARCHIVED/Archiviert, NOT_ACTIVE = "Neu" wenn nie aktiviert, sonst "Inaktiv" laut hasBeenActivated), die Spalte "Prozess" der separate Prozessstatus (processStatus: REQUESTED/Angefragt, ACCEPTED/Akzeptiert, REJECTED/Abgelehnt). "Aktiviert seit" ist activationDate (nur bei ACTIVE befüllt). Beides steht NUR im Sichtdaten-Key "community-kep-metering-points" bzw. über api_market-processes_getMeteringPoints — nicht in den Assignment-Daten. Die Prozesshistorie je Zählpunkt (processes[]: marketProcessType, startedOn = "Angefragt am", completedOn, status, participationFactor = angefragter bzw. initialer Teilnahmefaktor, previousParticipationFactor = vorheriger Teilnahmefaktor bei "Änderung Teilnahmefaktor") steht im Sichtdaten-Key "community-assigned-metering-points" bzw. über api_market-processes_getAssignedMeteringPoints. Der Kontaktname (assignmentContactName) ist der Kontakt der Zählpunkt-Zuordnung, NICHT der Name des Mitglieds. Bulk-Aktionen: Aktivieren, Deaktivieren, Energietarif ändern, Teilnahmefaktor ändern.',
      entityType: 'meteringPoint',
      capabilities: [
        { type: 'view', description: 'Zählpunkte anzeigen' },
        { type: 'select', entityType: 'meteringPoint' },
        {
          type: 'action',
          id: 'activateMeteringPoint',
          description: 'Ausgewählte Zählpunkte aktivieren',
        },
      ],
    });
  }

  pages.push({
    route: `${base}/profile`,
    name: 'Mein Profil',
    description: 'Persönliches Profil, Kontoeinstellungen und Zahlungsinformationen.',
    capabilities: [{ type: 'view', description: 'Profil anzeigen und bearbeiten' }],
  });

  return pages;
}
