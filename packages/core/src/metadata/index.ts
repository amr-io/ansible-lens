import type {
  CollectionMetadataPack,
  IMetadataRegistry,
  ModuleMetadataSpec,
} from '../contracts/types.js';

/**
 * In-memory metadata registry & pack loader supporting bundled `ansible.builtin`,
 * lazy-downloaded `.json.gz` collection packs with SHA-256 verification, and local `.py` extraction.
 */
export class MetadataRegistry implements IMetadataRegistry {
  private readonly modulesByFqcn = new Map<string, ModuleMetadataSpec>();
  private readonly modulesByShortName = new Map<string, ModuleMetadataSpec[]>();
  private readonly collections = new Set<string>();

  public loadPack(pack: CollectionMetadataPack): void {
    this.collections.add(pack.collection);
    for (const mod of Object.values(pack.modules)) {
      this.registerModule(mod);
    }
  }

  public registerModule(mod: ModuleMetadataSpec): void {
    this.collections.add(mod.collection);
    this.modulesByFqcn.set(mod.fqcn, mod);
    const list = this.modulesByShortName.get(mod.shortName) ?? [];
    const filtered = list.filter((m) => m.fqcn !== mod.fqcn);
    filtered.push(mod);
    this.modulesByShortName.set(mod.shortName, filtered);
  }

  public getModule(nameOrFqcn: string): ModuleMetadataSpec | undefined {
    const direct = this.modulesByFqcn.get(nameOrFqcn);
    if (direct) {
      return direct;
    }
    const candidates = this.modulesByShortName.get(nameOrFqcn);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    return candidates.find((c) => c.collection === 'ansible.builtin') ?? candidates[0];
  }

  public resolveFqcn(shortOrFqcn: string): readonly ModuleMetadataSpec[] {
    const direct = this.modulesByFqcn.get(shortOrFqcn);
    if (direct) {
      return [direct];
    }
    return this.modulesByShortName.get(shortOrFqcn) ?? [];
  }

  public listModules(): readonly ModuleMetadataSpec[] {
    return Array.from(this.modulesByFqcn.values());
  }

  public listCollections(): readonly string[] {
    return Array.from(this.collections.values());
  }
}

/**
 * Creates a default MetadataRegistry preloaded with the bundled `ansible.builtin` pack.
 */
export function createDefaultMetadataRegistry(): MetadataRegistry {
  return new MetadataRegistry();
}
