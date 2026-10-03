// Each summary represents a settled scan batch, independently of OS delivery receipts.
export class NotificationHistory {
  private readonly ids: Set<string>;
  constructor(value: unknown = []) {
    this.ids = new Set(
      Array.isArray(value)
        ? value
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200,
            )
            .slice(-200)
        : [],
    );
  }
  remember(id: string) {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > 200) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
  read() {
    return [...this.ids];
  }
}
