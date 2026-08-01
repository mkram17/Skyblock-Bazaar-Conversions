import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startCase, toLower } from 'lodash';
import romans from 'romans';

const BAZAAR_API_URL = 'https://api.hypixel.net/v2/skyblock/bazaar';

// Display names come from the NEU item repo rather than the SkyBlock items API.
// NEU's names are scraped from the items as they actually render in game, which is what
// consumers match against; the items API `name` field is often absent (every shard, most
// enchantment books) or stale (enchantments renamed in place, e.g. Arcane -> Woodsplitter).
const NEU_REPO_URL = 'https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO';

// Set to an existing NEU checkout to skip the clone (useful for local runs and CI caching).
const NEU_REPO_PATH_ENV = 'NEU_REPO_PATH';

const OUTPUT_FILE_NAME = 'bazaar-conversions.json';
const OUTPUT_PATH = path.join(process.cwd(), OUTPUT_FILE_NAME);

interface BazaarApiResponse {
    success: true;
    lastUpdated: number;
    products: Record<string, unknown>;
}
interface ApiErrorResponse {
    success: false;
    cause?: string;
}

interface NeuItem {
    displayname?: string;
    lore?: string[];
    [k: string]: any;
}

/** One entry of NEU's constants/bazaarstocks.json: Bazaar product id -> NEU item id. */
interface BazaarStock {
    stock?: string;
    id?: string;
}

interface NeuRepo {
    root: string;
    commit: string;
    /** Bazaar product id -> NEU item id, from constants/bazaarstocks.json */
    stocks: Map<string, string>;
}

/** How a product's display name was determined, for reporting. */
type NameSource = 'override' | 'neu-item' | 'neu-stock' | 'neu-alias' | 'sibling' | 'previous' | 'prettified';

interface ResolvedName {
    name: string;
    source: NameSource;
}

const ENDS_WITH_NUMBER = /\d$/;
const COLOR_CODE_PATTERN = /§[0-9A-FK-ORa-fk-or]/g;
const PLACEHOLDER_PATTERN = /%%\w+%%/g;

/** ENCHANTMENT_<family>_<level>, e.g. ENCHANTMENT_COUNTER_STRIKE_3 */
const ENCHANTMENT_ID_PATTERN = /^ENCHANTMENT_(?<family>.+)_(?<level>\d+)$/;
/** A display name ending in a level, e.g. "Counter-Strike V" or "Scuba 2" */
const TRAILING_LEVEL_PATTERN = /^(?<base>.*\S)\s+(?<level>[IVXLCDM]+|\d+)$/;

const MAX_ROMAN_LEVEL = 3999;

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

const stripFormatting = (name: string): string =>
    name.replace(COLOR_CODE_PATTERN, '').replace(PLACEHOLDER_PATTERN, '').trim();

/**
 * Last-resort prettifier for product ids NEU knows nothing about.
 * Only reached for oddities such as the level 0 placeholder enchantment products.
 */
export const idToName = (id: string): string => {
    let cleanId = id.replace(/^ENCHANTMENT_/, '');
    if (cleanId.startsWith('ULTIMATE_')) {
        cleanId = cleanId.replace(/^ULTIMATE_/, '');
    }

    const nameWithoutRoman = startCase(toLower(cleanId));
    if (!ENDS_WITH_NUMBER.test(nameWithoutRoman)) return nameWithoutRoman;

    const [n, ...strings] = nameWithoutRoman.split(' ').reverse() as [string, ...string[]];
    const decimal = Number.parseInt(n, 10);
    const romanNumeral = decimal <= 0 ? decimal : romans.romanize(decimal);
    return [romanNumeral, ...strings].reverse().join(' ');
};

function assertBazaarSuccess(resp: any): BazaarApiResponse {
    const ok = resp && resp.success === true && typeof resp.products === 'object' && resp.products !== null;
    if (!ok) {
        const cause = (resp as ApiErrorResponse)?.cause ?? 'Unknown API error';
        throw new Error(`Bazaar API returned an error: ${cause}`);
    }
    return resp;
}

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { 'User-Agent': 'bazaar-utils-generator' } });
    if (!res.ok) throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
    return res.json() as Promise<T>;
}

/** Clones NEU shallowly (or reuses the checkout named by NEU_REPO_PATH) and reads its stock map. */
export function openNeuRepo(): NeuRepo {
    const existing = process.env[NEU_REPO_PATH_ENV];
    const root = existing
        ? path.resolve(existing)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'neu-repo-'));

    if (existing) {
        console.log(`Using existing NEU checkout at ${root}`);
    } else {
        console.log(`Cloning ${NEU_REPO_URL}...`);
        execFileSync('git', ['clone', '--depth', '1', NEU_REPO_URL, root], { stdio: 'inherit' });
    }

    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const stocksPath = path.join(root, 'constants', 'bazaarstocks.json');
    const stocksRaw = JSON.parse(fs.readFileSync(stocksPath, 'utf8')) as BazaarStock[];
    const stocks = new Map<string, string>();
    for (const stock of stocksRaw) {
        if (stock.stock && stock.id) stocks.set(stock.stock, stock.id);
    }

    console.log(`NEU commit ${commit} (${stocks.size} bazaar stock mappings)`);
    return { root, commit, stocks };
}

const neuNameCache = new Map<string, string | null>();

/**
 * Reads a NEU item's display name.
 *
 * Enchantment books are all stored as a generic "Enchanted Book" item, with the enchantment
 * name in the first meaningful lore line, so those are read out of the lore instead.
 */
function readNeuName(neu: NeuRepo, neuId: string): string | null {
    const cached = neuNameCache.get(neuId);
    if (cached !== undefined) return cached;

    const resolved = readNeuNameUncached(neu, neuId);
    neuNameCache.set(neuId, resolved);
    return resolved;
}

function readNeuNameUncached(neu: NeuRepo, neuId: string): string | null {
    const itemPath = path.join(neu.root, 'items', `${neuId}.json`);
    if (!fs.existsSync(itemPath)) return null;

    let item: NeuItem;
    try {
        item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
    } catch (e) {
        console.warn(`Could not parse NEU item ${neuId}: ${(e as Error).message}`);
        return null;
    }

    const displayName = stripFormatting(item.displayname ?? '');
    if (displayName && displayName !== 'Enchanted Book') return displayName;

    for (const line of item.lore ?? []) {
        const stripped = stripFormatting(line);
        if (!stripped || stripped === 'Combinable in Anvil') continue;
        return stripped;
    }

    return displayName || null;
}

/**
 * Names an enchantment level NEU does not stock by borrowing a level it does.
 *
 * The Bazaar sells levels NEU has no item file for (Efficiency VI-X, Hecatomb II-X, ...).
 * Prettifying the id loses in-game spelling ("Counter Strike III" for "Counter-Strike III"),
 * so take a sibling level's name and swap the numeral, keeping the sibling's numeral style
 * because a few enchantments are displayed with arabic levels (e.g. "Scuba 2").
 */
function siblingLevelName(neu: NeuRepo, productId: string): string | null {
    const parsedId = ENCHANTMENT_ID_PATTERN.exec(productId);
    if (!parsedId?.groups) return null;

    const { family } = parsedId.groups;
    const level = Number.parseInt(parsedId.groups.level, 10);

    const siblings = [...neu.stocks.entries()]
        .flatMap(([stockId, neuId]) => {
            const parsed = ENCHANTMENT_ID_PATTERN.exec(stockId);
            if (!parsed?.groups || parsed.groups.family !== family || stockId === productId) return [];
            return [{ level: Number.parseInt(parsed.groups.level, 10), neuId }];
        })
        .sort((a, b) => a.level - b.level);

    for (const sibling of siblings) {
        const siblingName = readNeuName(neu, sibling.neuId);
        if (!siblingName) continue;

        const parsedName = TRAILING_LEVEL_PATTERN.exec(siblingName);
        if (!parsedName?.groups) continue;

        const arabic = /^\d+$/.test(parsedName.groups.level);
        return `${parsedName.groups.base} ${formatLevel(level, arabic)}`;
    }

    return null;
}

function formatLevel(level: number, arabic: boolean): string {
    if (arabic || level <= 0 || level > MAX_ROMAN_LEVEL) return String(level);
    return romans.romanize(level);
}

/**
 * Resolves one Bazaar product id to the name it is displayed under in game.
 * `previous` is the last generated file, kept as a floor so a NEU outage cannot
 * churn known-good names into prettified guesses.
 */
export function resolveProductName(
    neu: NeuRepo,
    productId: string,
    previous: Record<string, string>,
): ResolvedName {
    const override = NAME_OVERRIDES[productId];
    if (override) return { name: override, source: 'override' };

    const direct = readNeuName(neu, productId);
    if (direct) return { name: direct, source: 'neu-item' };

    const stockId = neu.stocks.get(productId);
    if (stockId) {
        const stockName = readNeuName(neu, stockId);
        if (stockName) return { name: stockName, source: 'neu-stock' };
    }

    const aliasId = NEU_ALIASES[productId];
    if (aliasId) {
        const aliasName = readNeuName(neu, aliasId);
        if (aliasName) return { name: aliasName, source: 'neu-alias' };
    }

    const sibling = siblingLevelName(neu, productId);
    if (sibling) return { name: sibling, source: 'sibling' };

    const known = previous[productId];
    if (known) return { name: known, source: 'previous' };

    return { name: idToName(productId), source: 'prettified' };
}

export function buildConversions(
    neu: NeuRepo,
    productIds: string[],
    previous: Record<string, string>,
): { conversions: Record<string, string>; sources: Record<NameSource, string[]> } {
    const conversions: Record<string, string> = {};
    const sources = {
        override: [], 'neu-item': [], 'neu-stock': [], 'neu-alias': [],
        sibling: [], previous: [], prettified: [],
    } as Record<NameSource, string[]>;

    for (const productId of [...productIds].sort((a, b) => a.localeCompare(b))) {
        const resolved = resolveProductName(neu, productId, previous);
        conversions[productId] = resolved.name;
        sources[resolved.source].push(productId);
    }

    return { conversions, sources };
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
    const bazaarData = assertBazaarSuccess(await fetchJson<any>(BAZAAR_API_URL));

    // The Bazaar itself remains authoritative for which product ids exist.
    const bazaarProductIds = Object.keys(bazaarData.products);
    console.log(`Bazaar currently lists ${bazaarProductIds.length} product IDs.`);

    const neu = openNeuRepo();
    const previous = readPreviousConversions();
    const { conversions, sources } = buildConversions(neu, bazaarProductIds, previous);

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(conversions, null, 2));
    console.log(`Wrote ${Object.keys(conversions).length} bazaar conversions to ${OUTPUT_PATH}`);

    const counts = Object.entries(sources)
        .map(([source, ids]) => `${source}=${ids.length}`)
        .join(', ');
    console.log(`Name sources (NEU commit ${neu.commit}): ${counts}`);

    // Anything NEU could not name is worth a human look: either the Bazaar added a product
    // NEU has not picked up yet, or the id shape is one the sibling template cannot handle.
    for (const [source, ids] of [['previous', sources.previous], ['prettified', sources.prettified]] as const) {
        if (ids.length) {
            console.log(`NOTE: ${ids.length} product IDs had no NEU name (${source}): ${ids.join(', ')}`);
        }
    }
}

if (require.main === module) {
    generateBazaarConversions().catch((e) => {
        console.error('Failed to generate bazaar conversions:', e);
        process.exit(1);
    });
}
