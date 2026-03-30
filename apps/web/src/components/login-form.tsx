import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { authClient } from "@/lib/auth-client";
import { getFirstErrorMessage } from "@/lib/form-errors";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { z } from "zod";

const loginFormSchema = z.object({
  email: z.email("Please enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

export function LoginForm({
  redirectTo,
  className,
  ...props
}: React.ComponentProps<"div"> & { redirectTo?: string }) {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    validators: {
      onChange: loginFormSchema,
    },
    onSubmit: async ({ value }) => {
      setErrorMessage(null);

      setIsPending(true);
      const { error } = await authClient.signIn.email({
        email: value.email,
        password: value.password,
      });
      setIsPending(false);

      if (error) {
        // TODO: Map Better Auth server validation details to field-level messages.
        setErrorMessage("Invalid credentials. Please check your input and try again.");
        return;
      }

      await navigate({ to: redirectTo || "/mail" });
    },
  });

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>Sign in to your Kirimail account</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="email">
                {(field) => {
                  const inlineError = field.state.meta.isTouched
                    ? getFirstErrorMessage(field.state.meta.errors)
                    : null;

                  return (
                    <Field>
                      <FieldLabel htmlFor="email">Email</FieldLabel>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        placeholder="mail@example.com"
                        required
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      {inlineError ? (
                        <FieldDescription className="text-destructive">
                          {inlineError}
                        </FieldDescription>
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
              <form.Field name="password">
                {(field) => {
                  const inlineError = field.state.meta.isTouched
                    ? getFirstErrorMessage(field.state.meta.errors)
                    : null;

                  return (
                    <Field>
                      <div className="flex items-center">
                        <FieldLabel htmlFor="password">Password</FieldLabel>
                        {/* TODO: Configure forgot password logic and change this */}
                        <a href="#" className="ml-auto text-sm underline-offset-4 hover:underline">
                          Forgot your password?
                        </a>
                      </div>
                      <Input
                        id="password"
                        name="password"
                        type="password"
                        required
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      {inlineError ? (
                        <FieldDescription className="text-destructive">
                          {inlineError}
                        </FieldDescription>
                      ) : null}
                    </Field>
                  );
                }}
              </form.Field>
              {errorMessage ? (
                <FieldDescription className="text-destructive">{errorMessage}</FieldDescription>
              ) : null}
              <Field>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Signing in..." : "Sign In"}
                </Button>
                <FieldDescription className="text-center">
                  Don&apos;t have an account?{" "}
                  <Link to="/sign-up" search={redirectTo ? { redirect: redirectTo } : undefined}>
                    Sign up
                  </Link>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        {/* TODO: Configure ToS and Privacy Policy and change this */}
        By signing in, you agree to our <a href="#">Terms of Service</a> and{" "}
        <a href="#">Privacy Policy</a>.
      </FieldDescription>
    </div>
  );
}
