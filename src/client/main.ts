import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  waitForEvenAppBridge,
} from "@evenrealities/even_hub_sdk";

function report(entry: object): void {
  console.log(JSON.stringify(entry));
}

async function start(): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      paddingLength: 8,
      containerID: 1,
      containerName: "startup",
      isEventCapture: 1,
      content: "PinGuard\nEven Hub Gate\nTap or swipe to verify input",
    })],
  }));
  report({ event: "createStartUpPageContainer", result });
  if (result !== StartUpPageCreateResult.success) return;

  const unsubscribe = bridge.onEvenHubEvent(({ sysEvent, textEvent }) => {
    // Protobuf omits the zero-valued click enum in system envelopes.
    const systemType = sysEvent && (sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT);
    const textType = textEvent?.eventType;
    if (systemType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      report({ event: "tap" });
    } else if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
      report({ event: "swipe", direction: "up" });
    } else if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      report({ event: "swipe", direction: "down" });
    }
  });
  window.addEventListener("beforeunload", unsubscribe, { once: true });
}

void start().catch((error: unknown) => {
  report({ event: "bridge_error", error: error instanceof Error ? error.message : "Bridge failed" });
});
