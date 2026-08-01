import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startCase, toLower } from 'lodash';
import romans from 'romans';

const BAZAAR_API_URL = 'https://api.hypixel.net/v2/skyblock/bazaar';

// Display names come from the NEU item repo rather than the SkyBlock items API. NEU's names
// are scraped from the items as they render in game, which is what consumers match against;
// the items API `name` field is often absent (every shard, most enchantment books) or stale
// (enchantments renamed in place, e.g. Arcane -> Woodsplitter).
// Set NEU_REPO_PATH to an existing checkout to skip the clone.
const NEU_REPO_URL = 'https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO';

const OUTPUT_FILE_NAME = 'bazaar-conversions.json';
const OUTPUT_PATH = path.join(process.cwd(), OUTPUT_FILE_NAME);

const COLOR_CODE_PATTERN = /§[0-9A-FK-ORa-fk-or]/g;
/** ENCHANTMENT_<family>_<level>, e.g. ENCHANTMENT_COUNTER_STRIKE_3 */
const ENCHANTMENT_ID_PATTERN = /^ENCHANTMENT_(?<family>.+)_(?<level>\d+)$/;
/** A name ending in a level, e.g. "Counter-Strike V" or "Scuba 2" */
const TRAILING_LEVEL_PATTERN = /^(?<base>.*\S)\s+(?<level>[IVXLCDM]+|\d+)$/;
/** romans.romanize rejects anything above this */
const MAX_ROMAN_LEVEL = 3999;

const NAME_SOURCES = [
    'override', 'neu-item', 'neu-stock', 'neu-alias', 'sibling', 'previous', 'prettified',
] as const;
type NameSource = (typeof NAME_SOURCES)[number];

interface NeuRepo {
    root: string;
    commit: string;
    /** Bazaar product id -> NEU item id, from constants/bazaarstocks.json */
    stocks: Map<string, string>;
}

interface ResolvedProduct {
    productId: string;
    name: string;
    source: NameSource;
}

// The Bazaar still lists a few legacy product ids whose NEU item file uses different spelling.
// Direct item files and bazaarstocks are both checked first, so these only cover the leftovers.
const NEU_ALIASES: Record<string, string> = {
    'INK_SACK:3': 'INK_SACK-3',
    'INK_SACK:4': 'INK_SACK-4',
    'LOG:1': 'LOG-1',
    'LOG:2': 'LOG-2',
    'LOG:3': 'LOG-3',
    'LOG_2:1': 'LOG_2-1',
    'RAW_FISH:1': 'RAW_FISH-1',
    'RAW_FISH:2': 'RAW_FISH-2',
    'RAW_FISH:3': 'RAW_FISH-3',
    'SAND:1': 'SAND-1',
    BAZAAR_COOKIE: 'BOOSTER_COOKIE',
    ENCHANTED_CARROT_ON_A_STICK: 'ENCHANTED_CARROT_STICK',
};

// Escape hatch for names NEU gets wrong or has not caught up with yet. Deliberately empty:
// NEU currently covers every Bazaar product, either directly or through the sibling-level
// template below. Add an entry here only as a stopgap, and drop it once NEU is fixed.
const NAME_OVERRIDES: Record<string, string> = {};

const stripFormatting = (name: string): string => name.replace(COLOR_CODE_PATTERN, '').trim();

/** Splits "Counter-Strike V" or "Scuba 2" into its base name and the numeral it ends with. */
function splitTrailingLevel(name: string) {
    const parsed = TRAILING_LEVEL_PATTERN.exec(name);
    if (!parsed?.groups) return null;

    const { base, level } = parsed.groups;
    return { base, level, arabic: /^\d+$/.test(level) };
}

function formatLevel(level: number, arabic: boolean): string {
    return arabic || level <= 0 || level > MAX_ROMAN_LEVEL ? String(level) : romans.romanize(level);
}

/** Last-resort prettifier for products NEU knows nothing about. */
function idToName(id: string): string {
    const name = startCase(toLower(id.replace(/^ENCHANTMENT_/, '').replace(/^ULTIMATE_/, '')));
    const trailing = splitTrailingLevel(name);
    // startCase always leaves the level arabic, so a roman tail here is part of the name.
    return trailing?.arabic ? `${trailing.base} ${formatLevel(Number(trailing.level), false)}` : name;
}

async function fetchBazaarProductIds(): Promise<string[]> {
    const res = await fetch(BAZAAR_API_URL, { headers: { 'User-Agent': 'bazaar-utils-generator' } });
    if (!res.ok) throw new Error(`Request failed ${res.status} ${res.statusText} for ${BAZAAR_API_URL}`);

    const body = (await res.json()) as { success?: boolean; cause?: string; products?: Record<string, unknown> };
    if (!body?.success || !body.products) {
        throw new Error(`Bazaar API returned an error: ${body?.cause ?? 'Unknown API error'}`);
    }
    return Object.keys(body.products);
}

/** Clones NEU shallowly (or reuses NEU_REPO_PATH) and reads its Bazaar stock map. */
export function openNeuRepo(): NeuRepo {
    const existing = process.env.NEU_REPO_PATH;
    const root = existing ? path.resolve(existing) : fs.mkdtempSync(path.join(os.tmpdir(), 'neu-repo-'));

    if (existing) {
        console.log(`Using existing NEU checkout at ${root}`);
    } else {
        console.log(`Cloning ${NEU_REPO_URL}...`);
        execFileSync('git', ['clone', '--depth', '1', NEU_REPO_URL, root], { stdio: 'inherit' });
    }

    const stocksPath = path.join(root, 'constants', 'bazaarstocks.json');
    const stocksRaw = JSON.parse(fs.readFileSync(stocksPath, 'utf8')) as { stock?: string; id?: string }[];
    const stocks = new Map(
        stocksRaw.flatMap((stock) => (stock.stock && stock.id ? [[stock.stock, stock.id] as const] : [])),
    );

    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    console.log(`NEU commit ${commit} (${stocks.size} bazaar stock mappings)`);
    return { root, commit, stocks };
}

/**
 * Reads a NEU item's display name. Enchantment books are all stored as a generic
 * "Enchanted Book" item with the enchantment in the first meaningful lore line.
 */
function readNeuName(neu: NeuRepo, neuId: string): string | null {
    const itemPath = path.join(neu.root, 'items', `${neuId}.json`);
    if (!fs.existsSync(itemPath)) return null;

    let item: { displayname?: string; lore?: string[] };
    try {
        item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
    } catch (e) {
        console.warn(`Could not parse NEU item ${neuId}: ${(e as Error).message}`);
        return null;
    }

    const displayName = stripFormatting(item.displayname ?? '');
    if (displayName && displayName !== 'Enchanted Book') return displayName;

    const loreName = (item.lore ?? [])
        .map(stripFormatting)
        .find((line) => line && line !== 'Combinable in Anvil');
    return loreName ?? null;
}

/**
 * Names an enchantment level NEU does not stock by borrowing one it does.
 *
 * The Bazaar sells levels with no NEU item file (Efficiency VI-X, Hecatomb II-X, ...), and
 * prettifying the id loses in-game spelling ("Counter Strike III"). Take a sibling level's
 * name and swap the numeral, keeping the sibling's numeral style because a few enchantments
 * are displayed with arabic levels (e.g. "Scuba 2").
 */
function siblingLevelName(neu: NeuRepo, productId: string): string | null {
    const parsed = ENCHANTMENT_ID_PATTERN.exec(productId);
    if (!parsed?.groups) return null;

    const { family, level } = parsed.groups;
    const siblings = [...neu.stocks]
        .flatMap(([stockId, neuId]) => {
            const sibling = ENCHANTMENT_ID_PATTERN.exec(stockId);
            return sibling?.groups && sibling.groups.family === family && stockId !== productId
                ? [{ level: Number(sibling.groups.level), neuId }]
                : [];
        })
        .sort((a, b) => a.level - b.level);

    for (const sibling of siblings) {
        const siblingName = readNeuName(neu, sibling.neuId);
        const trailing = siblingName ? splitTrailingLevel(siblingName) : null;
        if (trailing) return `${trailing.base} ${formatLevel(Number(level), trailing.arabic)}`;
    }

    return null;
}

/**
 * Resolves one Bazaar product id to the name it is displayed under in game. `previous` is the
 * last generated file, kept as a floor so a NEU outage cannot churn known-good names into
 * prettified guesses.
 */
function resolveProductName(
    neu: NeuRepo,
    productId: string,
    previous: Record<string, string>,
): Omit<ResolvedProduct, 'productId'> {
    const override = NAME_OVERRIDES[productId];
    if (override) return { name: override, source: 'override' };

    const direct = readNeuName(neu, productId);
    if (direct) return { name: direct, source: 'neu-item' };

    const stockId = neu.stocks.get(productId);
    const stockName = stockId ? readNeuName(neu, stockId) : null;
    if (stockName) return { name: stockName, source: 'neu-stock' };

    const aliasId = NEU_ALIASES[productId];
    const aliasName = aliasId ? readNeuName(neu, aliasId) : null;
    if (aliasName) return { name: aliasName, source: 'neu-alias' };

    const sibling = siblingLevelName(neu, productId);
    if (sibling) return { name: sibling, source: 'sibling' };

    const known = previous[productId];
    if (known) return { name: known, source: 'previous' };

    return { name: idToName(productId), source: 'prettified' };
}

/** Resolves every product, sorted by id so the generated file has a stable order. */
export function resolveProducts(
    neu: NeuRepo,
    productIds: string[],
    previous: Record<string, string>,
): ResolvedProduct[] {
    return [...productIds]
        .sort((a, b) => a.localeCompare(b))
        .map((productId) => ({ productId, ...resolveProductName(neu, productId, previous) }));
}

function readPreviousConversions(): Record<string, string> {
    if (!fs.existsSync(OUTPUT_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')) as Record<string, string>;
    } catch (e) {
        console.warn(`Could not read previous ${OUTPUT_FILE_NAME}: ${(e as Error).message}`);
        return {};
    }
}

async function generateBazaarConversions() {
    console.log('Fetching Bazaar products...');
    // The Bazaar itself remains authoritative for which product ids exist; NEU only names them.
    const productIds = await fetchBazaarProductIds();
    console.log(`Bazaar currently lists ${productIds.length} product IDs.`);

    const neu = openNeuRepo();
    const resolved = resolveProducts(neu, productIds, readPreviousConversions());
    const conversions = Object.fromEntries(resolved.map(({ productId, name }) => [productId, name]));

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(conversions, null, 2));
    console.log(`Wrote ${resolved.length} bazaar conversions to ${OUTPUT_PATH}`);

    const counts = NAME_SOURCES.map((s) => `${s}=${resolved.filter((r) => r.source === s).length}`);
    console.log(`Name sources (NEU commit ${neu.commit}): ${counts.join(', ')}`);

    // Anything NEU could not name is worth a human look: either the Bazaar added a product NEU
    // has not picked up yet, or the id shape is one the sibling template cannot handle.
    const unnamed = resolved.filter((r) => r.source === 'previous' || r.source === 'prettified');
    if (unnamed.length) {
        const listed = unnamed.map((r) => `${r.productId} (${r.source})`).join(', ');
        console.log(`NOTE: ${unnamed.length} product IDs had no NEU name: ${listed}`);
    }
}

if (require.main === module) {
    generateBazaarConversions().catch((e) => {
        console.error('Failed to generate bazaar conversions:', e);
        process.exit(1);
    });
}
