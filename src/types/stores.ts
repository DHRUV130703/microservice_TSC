/** A nearby store, enriched with landmark details from the store spreadsheet. */
export interface NearbyStore {
  storeId: string | null;
  storeName: string | null;
  shortCode: string | null;
  city: string | null;
  pincode: string | null;
  distanceKm: number | null;
  address: string | null;
  contact: string | null;
  timings: string | null;
  rating: string | null;
  reviewCount: string | null;
  parking: string | null;
  mapLink: string | null;
  storeUrl: string | null;
  latitude: string | null;
  longitude: string | null;
  comingSoon: boolean;
  /**
   * From the store spreadsheet, joined on store id. `null` when the locator
   * returned a store the spreadsheet does not cover — the store is still
   * reported, just without navigation help.
   */
  landmark: {
    /** Navigational line from the store spreadsheet. */
    detail: string | null;
    businessAddress: string | null;
    /**
     * Map link carried forward from the previous landmark table; the current
     * sheet does not cover it. Falls back to the locator's own `mapLink`.
     */
    mapUrl: string | null;
    /** The sheet's own name for the store, e.g. `Koramangala_Bengaluru`. */
    storeName: string | null;
  } | null;
}

export interface StoresPayload {
  pincode: string;
  /** The closest store, or `null` when the locator returned none. */
  nearest: NearbyStore | null;
  stores: NearbyStore[];
  meta: {
    storesReturned: number;
    landmarksMatched: number;
    cached: boolean;
    fetchedAt: string;
    ageSeconds: number;
  };
}

export interface StoresResult {
  payload: StoresPayload;
  message?: string;
}
