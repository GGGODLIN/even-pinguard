import { isObjectRecord, OsEventTypeList as EventType, pickLoose } from "@evenrealities/even_hub_sdk";

type GlassesEvent = "CLICK" | "SWIPE_UP" | "SWIPE_DOWN" | "DOUBLE_CLICK" | "FOREGROUND_ENTER" | "EXIT";

export function parseEvenHubEvent(raw: unknown): GlassesEvent | null {
  if (!isObjectRecord(raw)) return null;
  const system = isObjectRecord(raw.sysEvent) ? raw.sysEvent : undefined;
  const systemType: unknown = system?.eventType;
  const textType: unknown = isObjectRecord(raw.textEvent) ? raw.textEvent.eventType : undefined;

  if (systemType === EventType.SYSTEM_EXIT_EVENT || systemType === EventType.ABNORMAL_EXIT_EVENT) return "EXIT";
  if (systemType === EventType.DOUBLE_CLICK_EVENT || textType === EventType.DOUBLE_CLICK_EVENT) return "DOUBLE_CLICK";
  if (systemType === EventType.FOREGROUND_ENTER_EVENT) return "FOREGROUND_ENTER";

  if (raw.listEvent != null || raw.audioEvent != null || raw.menuItemClickEvent != null ||
      (raw.sysEvent != null && (!system || raw.textEvent != null))) return null;
  if (textType === EventType.SCROLL_TOP_EVENT) return "SWIPE_UP";
  if (textType === EventType.SCROLL_BOTTOM_EVENT) return "SWIPE_DOWN";
  if (system && (systemType === EventType.CLICK_EVENT || (systemType === undefined &&
      // The SDK normalizes unknown enum values to undefined too; only an omitted value is a tap.
      pickLoose(raw.jsonData, "eventType") === undefined))) return "CLICK";
  return null;
}
