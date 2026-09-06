"use client";

// An HTML form works in embedded browsers that disable JavaScript prompt().
export function requestText(
  message: string,
  password = false,
): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.createElement("dialog");
    dialog.className = "text-entry-dialog";
    dialog.setAttribute(
      "aria-label",
      password ? "App access code" : "Enter a specific name",
    );
    const form = document.createElement("form");
    const label = document.createElement("label");
    label.textContent = message;
    const input = document.createElement("input");
    input.type = password ? "password" : "text";
    input.autocomplete = password ? "current-password" : "off";
    input.required = true;
    label.append(input);
    const actions = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Continue";
    actions.append(cancel, submit);
    form.append(label, actions);
    dialog.append(form);
    document.body.append(dialog);
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      input.value = "";
      dialog.close();
      dialog.remove();
      previous?.focus();
      resolve(value);
    };
    cancel.onclick = () => finish(null);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    form.onsubmit = (event) => {
      event.preventDefault();
      if (input.value.trim()) finish(input.value.trim());
    };
    dialog.showModal();
    input.focus();
  });
}
