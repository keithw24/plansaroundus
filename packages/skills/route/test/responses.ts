// Hand-built computeRoutes responses in the documented shape (Routes API v2,
// proto3 JSON: zero values omitted, durations as "123s"). Not recorded from the
// live API: there is no Maps key yet. scripts/record-routes.ts records real ones.

export const WALK = {
  routes: [{ distanceMeters: 1180, duration: "874s" }],
};

export const DRIVE = {
  routes: [{ distanceMeters: 5320, duration: "1012s" }],
};

export const BICYCLE = {
  routes: [{ distanceMeters: 3010, duration: "641s" }],
};

const walkStep = { travelMode: "WALK" };

function ride(nameShort: string | undefined, type: string, stop: string, name?: string) {
  return {
    travelMode: "TRANSIT",
    transitDetails: {
      stopDetails: { arrivalStop: { name: stop } },
      transitLine: {
        ...(name ? { name } : {}),
        ...(nameShort ? { nameShort } : {}),
        vehicle: { type },
      },
    },
  };
}

/** Columbia → Harlem: one subway ride. */
export const TRANSIT_ONE_RIDE = {
  routes: [
    {
      distanceMeters: 4210,
      duration: "1326s",
      legs: [
        {
          steps: [
            walkStep,
            walkStep,
            ride("1", "SUBWAY", "116 St", "Broadway - 7 Avenue Local"),
            walkStep,
          ],
        },
      ],
    },
  ],
};

/** A subway ride, a transfer, then a second subway ride. */
export const TRANSIT_TRANSFER = {
  routes: [
    {
      distanceMeters: 9870,
      duration: "2105s",
      legs: [
        {
          steps: [
            walkStep,
            ride("A", "SUBWAY", "59 St - Columbus Circle"),
            walkStep,
            ride("2", "SUBWAY", "Wall St"),
            walkStep,
          ],
        },
      ],
    },
  ],
};

/** Bus, then subway, then two more buses: long chains are shortened. */
export const TRANSIT_MANY = {
  routes: [
    {
      distanceMeters: 15200,
      duration: "3650s",
      legs: [
        {
          steps: [
            ride("M4", "BUS", "Madison Av/E 110 St"),
            ride("6", "SUBWAY", "125 St"),
            ride("Bx15", "BUS", "3 Av/E 149 St"),
            ride(undefined, "BUS", "Hub", "Third Avenue Local"),
          ],
        },
      ],
    },
  ],
};

/** Transit mode, but Routes says just walk. */
export const TRANSIT_WALK_ONLY = {
  routes: [{ distanceMeters: 600, duration: "480s", legs: [{ steps: [walkStep, walkStep] }] }],
};

/** No route between the points: proto3 sends an empty object. */
export const EMPTY = {};

export const ERROR_403 = {
  error: {
    code: 403,
    message: "Requests to this API routes.googleapis.com method ... are blocked.",
    status: "PERMISSION_DENIED",
  },
};

export const ERROR_429 = {
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Compute Routes requests'.",
    status: "RESOURCE_EXHAUSTED",
  },
};
