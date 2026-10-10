declare module 'opening_hours' {
  type DateInput = Date | number;

  interface OpeningHoursOptions {
    mode?: number;
    tag_key?: string;
    map_value?: boolean;
    warnings_severity?: number;
    locales?: string[];
  }

  class OpeningHours {
    constructor(value: string, nominatim?: unknown, options?: OpeningHoursOptions | number);
    getState(date?: DateInput): boolean;
    getUnknown(date?: DateInput): boolean | string;
    getComment(date?: DateInput): string;
    getOpenIntervals(from?: DateInput, to?: DateInput): Array<[Date, Date, boolean, string]>;
    getNextChange(date?: DateInput): Date | undefined;
    getWarnings(): string[];
    prettifyValue(): string;
  }

  export = OpeningHours;
}
