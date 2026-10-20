export const discordText = (value: string) => value.replace(/[\r\n]/g, " ").replace(/@/g, "＠").replace(/[\\[\]()*_~`|>#<>]/g, "\\$&");
