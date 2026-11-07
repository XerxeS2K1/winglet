import { forwardRef } from 'react';
import { Platform, TextInput as NativeTextInput, type TextInputProps } from 'react-native';
import { useTheme } from '../lib/themeContext';

// Keep the native instance type so existing imperative focus/blur/selection refs remain unchanged.
export type TextInput = NativeTextInput;

/** Selected Winglet theme defaults, with the caller's explicit props/styles taking precedence. */
export const TextInput = forwardRef<NativeTextInput, TextInputProps>(function ThemedTextInput({ style, ...props }, ref) {
  const t = useTheme();
  return <NativeTextInput
    placeholderTextColor={t.colors.textTertiary}
    selectionColor={t.colors.accent}
    {...(Platform.OS === 'android' ? { cursorColor: t.colors.accent, selectionHandleColor: t.colors.accent } : {})}
    {...(Platform.OS === 'ios' ? { keyboardAppearance: t.scheme } : {})}
    {...props}
    ref={ref}
    style={[{ color: t.colors.text }, style]}
  />;
});
