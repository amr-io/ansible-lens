import { createDefaultMetadataRegistry } from '@ansible-lens/core';

export function createServerContext(): { readonly initialized: boolean } {
  const registry = createDefaultMetadataRegistry();
  return {
    initialized: registry.listCollections().length >= 0,
  };
}
